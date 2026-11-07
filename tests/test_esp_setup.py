import http.client
import json
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch

from macos.esp_setup import SetupError, SetupService, make_server

class SetupTests(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.root=Path(self.tmp.name);(self.root/'runtime').mkdir()
  (self.root/'runtime/config.yaml').write_text('ble:\n  mac: "AA:BB:CC:DD:EE:FF"\n  token: "'+'ab'*12+'"\n  ble_key: "'+'cd'*16+'"\nserver:\n  port: 18299\n')
  (self.root/'runtime/cloud-secrets.json').write_text(json.dumps({'device_token':'test-cloud-only'}))
  (self.root/'runtime/deployment.json').write_text(json.dumps({'hostname':'charge.example.test'}))
 def tearDown(self):self.tmp.cleanup()
 def test_payload_uses_only_this_project_and_fixed_target(self):
  service=SetupService(self.root);captured=[]
  def transport(payload):captured.append(payload);return {'ok':True}
  with patch.object(service,'_post_esp',transport):self.assertEqual(service.configure({'ssid':'Home 2.4G','password':'wifi-test-password'}),{'ok':True,'message':'ESP32 已确认保存配置，正在重启；连接云端与 BLE 尚待验证。'})
  p=captured[0];self.assertEqual(p['cloud_url'],'wss://charge.example.test/api/device');self.assertEqual(p['device_token'],'ab'*12);self.assertEqual(p['cloud_token'],'test-cloud-only');self.assertNotIn('viewer_password',p)
  self.assertEqual(len(list((self.root/'runtime').iterdir())),3)
 def test_device_token_and_ble_key_exact_firmware_lengths(self):
  service=SetupService(self.root)
  self.assertEqual(service._device()[1]['device_token'],'ab'*12)
  self.assertEqual(service._device()[1]['device_ble_key'],'cd'*16)
  for token,key in [('ab'*16,'cd'*16),('ab'*11,'cd'*16),('ab'*12,'cd'*12),('ab'*12,'cd'*17)]:
   (self.root/'runtime/config.yaml').write_text(f'ble:\n  mac: "AA:BB:CC:DD:EE:FF"\n  token: "{token}"\n  ble_key: "{key}"\n')
   with self.assertRaises(SetupError):service._device()
 def test_missing_device_and_invalid_wifi_do_not_send(self):
  service=SetupService(self.root)
  with self.assertRaises(SetupError):service.configure({'ssid':'x','password':'short'})
  (self.root/'runtime/config.yaml').write_text('ble: {}')
  with patch.object(service,'_post_esp') as post:
   with self.assertRaises(SetupError):service.configure({'ssid':'x','password':'valid-pass'})
   post.assert_not_called()
 def test_target_timeout_failure_is_redacted_and_redirect_not_followed(self):
  service=SetupService(self.root)
  with patch('macos.esp_setup.http.client.HTTPConnection',side_effect=TimeoutError('secret detail')) as cls:
   with self.assertRaisesRegex(SetupError,'ESP32') as err:service.configure({'ssid':'x','password':'valid-pass'})
   self.assertNotIn('secret detail',str(err.exception));cls.assert_called_once_with('192.168.4.1',80,timeout=8)
 def test_esp_response_must_confirm_and_never_redirects(self):
  from unittest.mock import MagicMock
  service=SetupService(self.root)
  for status,body,success in [(200,b'{"ok":true}',True),(200,b'{"ok":false}',False),(302,b'{"ok":true}',False),(200,b'not JSON',False)]:
   connection=MagicMock();response=connection.getresponse.return_value;response.status=status;response.read.return_value=body
   with patch('macos.esp_setup.http.client.HTTPConnection',return_value=connection) as cls:
    if success:self.assertTrue(service.configure({'ssid':'Home','password':'valid-pass'})['ok'])
    else:
     with self.assertRaises(SetupError):service.configure({'ssid':'Home','password':'valid-pass'})
    cls.assert_called_once_with('192.168.4.1',80,timeout=8);self.assertEqual(connection.request.call_args.args[:2],('POST','/api/config'));connection.close.assert_called_once()
 def test_loopback_host_origin_csrf_and_no_secret_response(self):
  service=SetupService(self.root);server=make_server(service,0);thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start();port=server.server_port;origin=f'http://127.0.0.1:{port}'
  def req(method,path,body=None,headers=None):
   c=http.client.HTTPConnection('127.0.0.1',port);c.request(method,path,body=body,headers=headers or {});r=c.getresponse();out=(r.status,r.read().decode());c.close();return out
  try:
   status,html=req('GET','/');self.assertEqual(status,200);self.assertNotIn('test-cloud-only',html);self.assertNotIn('abababab',html)
   self.assertEqual(req('GET','/',headers={'Host':'evil.test'})[0],403)
   self.assertEqual(req('POST','/api/configure','{}',{'Origin':'https://evil.test','Content-Type':'application/json'})[0],403)
   self.assertEqual(req('POST','/api/configure','{}',{'Origin':origin,'Content-Type':'application/json'})[0],403)
   self.assertEqual(req('GET','/api/state')[0],200)
   with patch.object(service,'_post_esp',return_value={'ok':True}) as post:
    self.assertEqual(req('POST','/api/configure',json.dumps({'ssid':'Home','password':'valid-pass'}),{'Origin':origin,'Content-Type':'application/json','X-CSRF-Token':service.csrf})[0],200);post.assert_called_once()
  finally:server.shutdown();server.server_close();thread.join()

if __name__=='__main__':unittest.main()

class OneTimeTokenTests(SetupTests):
 def test_override_token_is_not_returned_or_written(self):
  service=SetupService(self.root); secret='one-time-secret'; before={p.name:p.read_bytes() for p in (self.root/'runtime').iterdir()}
  with patch.object(service,'_post_esp') as post:
   response=service.configure({'ssid':'Home','password':'valid-pass','cloud_token':secret})
   self.assertEqual(post.call_args.args[0]['cloud_token'],secret)
   self.assertNotIn(secret,json.dumps(response))
  self.assertEqual(before,{p.name:p.read_bytes() for p in (self.root/'runtime').iterdir()})
  with patch.object(service,'_post_esp') as post:
   with self.assertRaises(SetupError):service.configure({'ssid':'Home','password':'valid-pass','cloud_token':'bad token'})
   post.assert_not_called()
