import test from 'node:test';
import assert from 'node:assert/strict';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { fileURLToPath } from 'node:url';

test('workerd registers two isolated gateways and revokes only the selected credential', async () => {
 const mf=new Miniflare(convertV4MiniflareOptions({modules:['worker.js','room.js','protocol.js','login-limiter.js','history.js','history-api.js','energy.js'].map(name=>({type:'ESModule',path:fileURLToPath(new URL('../src/'+name,import.meta.url))})),compatibilityDate:'2026-11-01',durableObjects:{ROOM:{className:'TelemetryRoom',useSQLite:true},LOGIN_LIMITER:{className:'LoginLimiter',useSQLite:true}},bindings:{VIEWER_PASSWORD:'viewer',DEVICE_TOKEN:'device',SESSION_SECRET:'secret'}}));
 const origin='https://devices.example';
 try {
  const login=await mf.dispatchFetch(origin+'/api/login',{method:'POST',headers:{Origin:origin},body:'{"password":"viewer"}'});
  const cookie=login.headers.get('set-cookie').split(';')[0];
  const post=(path,body)=>mf.dispatchFetch(origin+path,{method:'POST',headers:{Origin:origin,Cookie:cookie},body:JSON.stringify(body)});
  const get=path=>mf.dispatchFetch(origin+path,{headers:{Cookie:cookie}});
  const register=async name=>{const response=await post('/api/devices/register',{name});assert.equal(response.status,201);return response.json();};
  const a=await register('A'), b=await register('B');
  assert.notEqual(a.device.id,b.device.id);assert.notEqual(a.provisioning.cloud_token,b.provisioning.cloud_token);
  const connect=token=>mf.dispatchFetch(origin+'/api/device',{headers:{Upgrade:'websocket',Authorization:`Bearer ${token}`}});
  const ar=await connect(a.provisioning.cloud_token),br=await connect(b.provisioning.cloud_token);assert.equal(ar.status,101);assert.equal(br.status,101);ar.webSocket.accept();br.webSocket.accept();
  const telemetry=power=>({type:'telemetry',version:1,seq:1,uptimeMs:10,bleConnected:true,ports:['c1','c2','c3','a'].map(id=>({id,voltage:5,current:1,power,active:true,valid:true,protocol:'PD'}))});
  ar.webSocket.send(JSON.stringify(telemetry(5)));br.webSocket.send(JSON.stringify(telemetry(9)));
  let as,bs;for(let i=0;i<40;i++){as=await (await get('/api/status?device='+a.device.id)).json();bs=await (await get('/api/status?device='+b.device.id)).json();if(as.ports?.['1']?.power===5&&bs.ports?.['1']?.power===9)break;await new Promise(r=>setTimeout(r,10));}
  assert.equal(as.ports['1'].power,5);assert.equal(bs.ports['1'].power,9);
  const live=await mf.dispatchFetch(origin+'/api/live',{headers:{Upgrade:'websocket',Origin:origin,Cookie:cookie}});assert.equal(live.status,101);
  const initial=[];live.webSocket.addEventListener('message',e=>initial.push(JSON.parse(e.data)));live.webSocket.accept();
  for(let i=0;i<40&&(!initial.some(x=>x.type==='init'&&x.device===a.device.id)||!initial.some(x=>x.type==='init'&&x.device===b.device.id));i++)await new Promise(r=>setTimeout(r,10));
  assert.ok(initial.some(x=>x.type==='init'&&x.device===a.device.id&&x.devices.some(d=>d.id===b.device.id)));
  assert.ok(initial.some(x=>x.type==='init'&&x.device===b.device.id&&x.devices.some(d=>d.id===a.device.id)));
  const ack=ws=>new Promise(resolve=>ws.addEventListener('message',function receive(e){const d=JSON.parse(e.data);if(d.type==='history_ack'){ws.removeEventListener('message',receive);resolve(d);}}));
  const batchId=crypto.randomUUID(),t=Math.floor(Date.now()/1000)-60;
  const samples=Array.from({length:40},(_,i)=>({timestamp:t+i,ports:['c1','c2','c3','a'].map((id,j)=>({id,voltage:j?0:5,current:j?0:2,power:j?0:10,active:!j,valid:true,protocol:j?'idle':'PD'}))}));
  const aa=ack(ar.webSocket),ba=ack(br.webSocket),batch=JSON.stringify({type:'history_batch',version:1,id:batchId,samples});ar.webSocket.send(batch);br.webSocket.send(batch);
  assert.equal((await aa).accepted,40);assert.equal((await ba).accepted,40);
  assert.equal((await (await get(`/api/history/1?device=${a.device.id}`)).json()).data.length,40);
  assert.equal((await (await get(`/api/history/1?device=${b.device.id}`)).json()).data.length,40);
  assert.equal((await get(`/api/device/${a.device.id}/status?device=${b.device.id}`)).status,400);
  assert.equal((await get(`/api/status?device=${a.device.id}&device=${b.device.id}`)).status,400);
  assert.equal((await (await get(`/api/device/${a.device.id}/status`)).json()).ports['1'].power,5);
  const nextCommand=ws=>new Promise(resolve=>ws.addEventListener('message',function receive(e){const d=JSON.parse(e.data);if(d.type==='command'){ws.removeEventListener('message',receive);resolve(d);}}));
  const ac=nextCommand(ar.webSocket),bc=nextCommand(br.webSocket);
  const ap=post(`/api/port?device=${a.device.id}`,{port:'c1',action:'on'}),bp=post(`/api/port?device=${b.device.id}`,{port:'c1',action:'on'});
  const [cmdA,cmdB]=await Promise.all([ac,bc]);assert.notEqual(cmdA.id,cmdB.id);
  assert.equal((await post(`/api/port?device=${a.device.id}`,{port:'c1',action:'on'})).status,409);
  br.webSocket.send(JSON.stringify({type:'command_result',id:cmdA.id,ok:true}));
  assert.equal(await Promise.race([ap.then(()=>true),new Promise(r=>setTimeout(()=>r(false),30))]),false);
  br.webSocket.send(JSON.stringify({type:'command_result',id:cmdB.id,ok:true}));assert.equal((await bp).status,200);
  ar.webSocket.send(JSON.stringify({type:'command_result',id:cmdA.id,ok:true}));assert.equal((await ap).status,200);
  assert.equal((await post(`/api/devices/${a.device.id}/rename`,{name:'Renamed'})).status,200);
  const rotation=await post(`/api/devices/${b.device.id}/rotate-token`,{});assert.equal(rotation.status,200);const rotated=await rotation.json();
  assert.equal((await connect(b.provisioning.cloud_token)).status,401);
  const newB=await connect(rotated.provisioning.cloud_token);assert.equal(newB.status,101);newB.webSocket.accept();newB.webSocket.send(JSON.stringify(telemetry(9)));
  for(let i=0;i<40;i++){bs=await (await get('/api/status?device='+b.device.id)).json();if(bs.ports?.['1']?.power===9)break;await new Promise(r=>setTimeout(r,10));}
  const list=await (await get('/api/devices')).json();assert.ok(list.devices.some(d=>d.id===a.device.id));assert.ok(!JSON.stringify(list).includes(a.provisioning.cloud_token));
  const before=await (await get(`/api/sessions?period=all&device=${a.device.id}`)).json();assert.equal(before.sessions.length,1);
  assert.equal((await post(`/api/devices/${a.device.id}/revoke`,{})).status,200);
  const archived=await (await get('/api/devices?include_archived=1')).json();assert.ok(archived.devices.some(d=>d.id===a.device.id&&d.status==='disabled'));assert.ok(!JSON.stringify(archived).includes(a.provisioning.cloud_token));
  const after=await (await get(`/api/sessions?period=all&device=${a.device.id}`)).json();assert.equal(after.sessions[0].id,before.sessions[0].id);
  assert.equal((await get(`/api/sessions/${before.sessions[0].id}/points?device=${b.device.id}`)).status,404);
  assert.equal((await post(`/api/port?device=${a.device.id}`,{port:'c1',action:'on'})).status,409);
  assert.equal((await post(`/api/sessions/delete?device=${a.device.id}`,{ids:[before.sessions[0].id]})).status,409);
  assert.equal((await post('/api/devices/default/revoke',{})).status,200);assert.equal((await connect('device')).status,401);
  assert.equal((await connect(a.provisioning.cloud_token)).status,401);
  assert.equal((await (await get('/api/status?device='+b.device.id)).json()).ports['1'].power,9);
  ar.webSocket.close();br.webSocket.close();newB.webSocket.close();live.webSocket.close();
 } finally { await mf.dispose(); }
});
