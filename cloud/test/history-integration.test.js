import test from 'node:test';import assert from 'node:assert/strict';import {Miniflare,convertV4MiniflareOptions} from 'miniflare';import {fileURLToPath} from 'node:url';
import {validateHistoryBatch} from '../src/protocol.js';
const sample=t=>({timestamp:t,ports:['c1','c2','c3','a'].map((id,i)=>({id,voltage:i?0:5,current:i?0:2,power:i?0:10,active:!i,valid:true,protocol:i?'idle':'PD'}))});
test('history_batch has independent strict schema and realistic ordered timestamps',()=>{const now=Date.now()/1000,b={type:'history_batch',version:1,id:crypto.randomUUID(),samples:[sample(now-1)]};assert.deepEqual(validateHistoryBatch(b),b);const disabled=structuredClone(b);disabled.samples[0].ports[0].enabled=false;assert.deepEqual(validateHistoryBatch(disabled),disabled);disabled.samples[0].ports[0].enabled=0;assert.throws(()=>validateHistoryBatch(disabled));for(const mutate of [x=>x.token='x',x=>x.samples[0].ports[0].mac='x',x=>x.samples[0].timestamp=Date.now(),x=>x.samples.push(x.samples[0])]){const bad=structuredClone(b);mutate(bad);assert.throws(()=>validateHistoryBatch(bad));}});
test('workerd stores only history_batch and protects history mutations',async()=>{
 const mf=new Miniflare(convertV4MiniflareOptions({modules:['worker.js','room.js','protocol.js','login-limiter.js','history.js','history-api.js','energy.js'].map(name=>({type:'ESModule',path:fileURLToPath(new URL('../src/'+name,import.meta.url))})),compatibilityDate:'2026-11-01',durableObjects:{ROOM:{className:'TelemetryRoom',useSQLite:true},LOGIN_LIMITER:{className:'LoginLimiter',useSQLite:true}},bindings:{VIEWER_PASSWORD:'viewer',DEVICE_TOKEN:'device',SESSION_SECRET:'secret'}}));
 try{
  const origin='https://history.example';const login=await mf.dispatchFetch(origin+'/api/login',{method:'POST',headers:{Origin:origin},body:'{"password":"viewer"}'});const cookie=login.headers.get('set-cookie').split(';')[0];const get=path=>mf.dispatchFetch(origin+path,{headers:{Cookie:cookie}});
  assert.equal((await mf.dispatchFetch(origin+'/api/sessions')).status,401);assert.equal((await mf.dispatchFetch(origin+'/api/sessions/clear',{method:'POST',headers:{Cookie:cookie,Origin:'https://evil.example'}})).status,403);assert.equal((await mf.dispatchFetch(origin+'/api/sessions',{method:'POST',headers:{Cookie:cookie,Origin:origin}})).status,405);
  let device=await mf.dispatchFetch(origin+'/api/device',{headers:{Upgrade:'websocket',Authorization:'Bearer device'}});let ws=device.webSocket;ws.accept();
  const t=Math.floor(Date.now()/1000)-60;ws.send(JSON.stringify({type:'telemetry',version:1,seq:1,uptimeMs:1,bleConnected:true,ports:sample(t).ports}));assert.equal((await (await get('/api/history/1')).json()).data.length,0);
  const ack=new Promise(resolve=>ws.addEventListener('message',function receive(e){const d=JSON.parse(e.data);if(d.type==='history_ack'){ws.removeEventListener('message',receive);resolve(d);}}));const batchId=crypto.randomUUID();const samples=Array.from({length:40},(_,i)=>sample(t+i));ws.send(JSON.stringify({type:'history_batch',version:1,id:batchId,samples}));const firstAck=await ack;assert.equal(firstAck.id,batchId);assert.equal(firstAck.accepted,40);ws.close();
  device=await mf.dispatchFetch(origin+'/api/device',{headers:{Upgrade:'websocket',Authorization:'Bearer device'}});ws=device.webSocket;ws.accept();const retryAck=new Promise(resolve=>ws.addEventListener('message',e=>{const d=JSON.parse(e.data);if(d.type==='history_ack')resolve(d);}));ws.send(JSON.stringify({type:'history_batch',version:1,id:batchId,samples}));assert.deepEqual(await retryAck,{type:'history_ack',id:batchId,accepted:0});
  const readings=await (await get('/api/history/1')).json();assert.equal(readings.data.length,40);const sessions=await (await get('/api/sessions?period=all')).json();assert.equal(sessions.total,1);
  const chartPath='/api/chart?hours=1&interval=300';
  const chart=await get(chartPath);assert.equal(chart.status,200);
  const etag=chart.headers.get('etag');assert.ok(etag);
  const unchanged=await mf.dispatchFetch(origin+chartPath,{headers:{Cookie:cookie,'If-None-Match':etag}});
  assert.equal(unchanged.status,304);
  assert.equal((await mf.dispatchFetch(origin+'/api/port-modes',{method:'POST',headers:{Origin:origin,Cookie:cookie},body:'{}'})).status,503);
  assert.equal((await mf.dispatchFetch(origin+'/api/charge-limits',{method:'POST',headers:{Origin:origin,Cookie:cookie},body:'{}'})).status,503);
  const deleted=await mf.dispatchFetch(origin+'/api/sessions/clear',{method:'POST',headers:{Origin:origin,Cookie:cookie},body:'{}'});assert.equal(deleted.status,200);ws.close();
 }finally{await mf.dispose();}
});
