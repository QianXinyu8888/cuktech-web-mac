import test from 'node:test';
import assert from 'node:assert/strict';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { fileURLToPath } from 'node:url';
test('Workers runtime forwards telemetry with a full settings and automation snapshot',async()=>{
 const mf=new Miniflare(convertV4MiniflareOptions({modules:['worker.js','room.js','protocol.js','login-limiter.js','history.js','history-api.js','energy.js'].map(name=>({type:'ESModule',path:fileURLToPath(new URL('../src/'+name,import.meta.url))})),compatibilityDate:'2026-11-01',durableObjects:{ROOM:{className:'TelemetryRoom',useSQLite:true},LOGIN_LIMITER:{className:'LoginLimiter',useSQLite:true}},bindings:{VIEWER_PASSWORD:'runtime-viewer',DEVICE_TOKEN:'runtime-device',SESSION_SECRET:'runtime-session'}}));
 try{
  const origin='https://cloud.example';
  const login=await mf.dispatchFetch(`${origin}/api/login`,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({password:'runtime-viewer'})});
  assert.equal(login.status,200);const cookie=login.headers.get('set-cookie').split(';')[0];
  const viewer=await mf.dispatchFetch(`${origin}/api/live`,{headers:{Upgrade:'websocket',Origin:origin,Cookie:cookie}});assert.equal(viewer.status,101);viewer.webSocket.accept();
  const received=[];viewer.webSocket.addEventListener('message',event=>received.push(JSON.parse(event.data)));
  const device=await mf.dispatchFetch(`${origin}/api/device`,{headers:{Upgrade:'websocket',Authorization:'Bearer runtime-device'}});assert.equal(device.status,101);device.webSocket.accept();
  const rate=new Promise(resolve=>device.webSocket.addEventListener('message',e=>resolve(JSON.parse(e.data)),{once:true}));
  assert.deepEqual(await rate,{type:'rate',intervalMs:1000});
  const ports=['c1','c2','c3','a'];
  const automation={type:'automation_state',version:1,chargeLimits:Object.fromEntries(ports.map(port=>[port,{wh:999.123456789,mode:'always',sessionWh:1234.1234567,fired:false,pending:false,error:'x'.repeat(160)}])),permanent:[],fullOff:{}};
  const settings={type:'settings',version:1,settings:{'5':4,'6':5,'8':1440,'9':1440,'10':1440,'11':1440,'12':1440,'13':1,'15':1,'16':15,'19':1,'20':1,'21':0xffffffff},protocolExtend:0xffffffff,deviceModel:'M'.repeat(64),firmwareVersion:'V'.repeat(64)};
  const telemetry={type:'telemetry',version:1,seq:1,uptimeMs:10,bleConnected:true,ports:ports.map(id=>({id,voltage:19.123456789,current:2.123456789,power:40.123456789,active:true,valid:true,protocol:'P'.repeat(32)}))};
  const outcome=new Promise(resolve=>{
   viewer.webSocket.addEventListener('message',e=>{const data=JSON.parse(e.data);if(data.type==='telemetry')resolve(data.type);});
   device.webSocket.addEventListener('close',e=>resolve(e.reason),{once:true});
  });
  for(const message of [settings,automation,telemetry])device.webSocket.send(JSON.stringify(message));
  assert.equal(await outcome,'telemetry');
  const status=await (await mf.dispatchFetch(origin+'/api/status',{headers:{Cookie:cookie}})).json();
  assert.equal(status.device_model,settings.deviceModel);
  assert.equal(status.ports['1'].power,telemetry.ports[0].power);
  assert.ok(received.some(x=>x.type==='status'&&x.deviceConnected));
  viewer.webSocket.close();device.webSocket.close();
 }finally{await mf.dispose();}
});
test('Workers runtime persists login limit and logout revokes active sockets',async()=>{
 const mf=new Miniflare(convertV4MiniflareOptions({modules:['worker.js','room.js','protocol.js','login-limiter.js','history.js','history-api.js','energy.js'].map(name=>({type:'ESModule',path:fileURLToPath(new URL('../src/'+name,import.meta.url))})),compatibilityDate:'2026-11-01',durableObjects:{ROOM:{className:'TelemetryRoom',useSQLite:true},LOGIN_LIMITER:{className:'LoginLimiter',useSQLite:true}},bindings:{VIEWER_PASSWORD:'viewer',DEVICE_TOKEN:'device',SESSION_SECRET:'secret'}}));
 try{
  const origin='https://example.test';const login=password=>mf.dispatchFetch(origin+'/api/login',{method:'POST',headers:{Origin:origin,'CF-Connecting-IP':'192.0.2.1'},body:JSON.stringify({password})});
  for(let i=0;i<5;i++)assert.equal((await login('wrong')).status,401);
  assert.equal((await login('viewer')).status,429);
  const good=await mf.dispatchFetch(origin+'/api/login',{method:'POST',headers:{Origin:origin,'CF-Connecting-IP':'192.0.2.2'},body:JSON.stringify({password:'viewer'})});assert.equal(good.status,200);const cookie=good.headers.get('set-cookie').split(';')[0];
  const response=await mf.dispatchFetch(origin+'/api/live',{headers:{Origin:origin,Upgrade:'websocket',Cookie:cookie}});assert.equal(response.status,101);const ws=response.webSocket;ws.accept();const closed=new Promise(resolve=>ws.addEventListener('close',e=>{ws.close();resolve(e);},{once:true}));
  const logout=await mf.dispatchFetch(origin+'/api/logout',{method:'POST',headers:{Origin:origin,Cookie:cookie}});assert.equal(logout.status,200);await closed;
  assert.equal((await mf.dispatchFetch(origin+'/api/session',{headers:{Cookie:cookie}})).status,401);
  assert.equal((await mf.dispatchFetch(origin+'/api/live',{headers:{Origin:origin,Upgrade:'websocket',Cookie:cookie}})).status,401);
 }finally{await mf.dispose();}
});
test('Workers runtime expires an already connected viewer before ping',async()=>{
 const { signSession }=await import('../src/worker.js');
 const mf=new Miniflare(convertV4MiniflareOptions({modules:['worker.js','room.js','protocol.js','login-limiter.js','history.js','history-api.js','energy.js'].map(name=>({type:'ESModule',path:fileURLToPath(new URL('../src/'+name,import.meta.url))})),compatibilityDate:'2026-11-01',durableObjects:{ROOM:{className:'TelemetryRoom',useSQLite:true},LOGIN_LIMITER:{className:'LoginLimiter',useSQLite:true}},bindings:{VIEWER_PASSWORD:'viewer',DEVICE_TOKEN:'device',SESSION_SECRET:'short-secret'}}));
 try{
  await mf.ready;
  const token=await signSession('short-secret',Date.now()-12*3600*1000+700);
  const response=await mf.dispatchFetch('https://expire.example/api/live',{headers:{Origin:'https://expire.example',Upgrade:'websocket',Cookie:`cuktech_session=${token}`}});assert.equal(response.status,101);const ws=response.webSocket;ws.accept();
  const messages=[];ws.addEventListener('message',e=>messages.push(JSON.parse(e.data)));
  const closed=new Promise(resolve=>ws.addEventListener('close',e=>{ws.close();resolve(e);},{once:true}));
  await new Promise(resolve=>setTimeout(resolve,800));ws.send('{"type":"ping"}');assert.equal((await closed).code,1008);assert.equal(messages.some(x=>x.type==='pong'),false);
 }finally{await mf.dispose();}
});
test('Workers runtime HTTP controls require viewer and actual device ack; pending and timeout fail explicitly',async()=>{
 const mf=new Miniflare(convertV4MiniflareOptions({modules:['worker.js','room.js','protocol.js','login-limiter.js','history.js','history-api.js','energy.js'].map(name=>({type:'ESModule',path:fileURLToPath(new URL('../src/'+name,import.meta.url))})),compatibilityDate:'2026-11-01',durableObjects:{ROOM:{className:'TelemetryRoom',useSQLite:true},LOGIN_LIMITER:{className:'LoginLimiter',useSQLite:true}},bindings:{VIEWER_PASSWORD:'viewer',DEVICE_TOKEN:'device',SESSION_SECRET:'secret'}}));
 try{
  const origin='https://control.example';const login=await mf.dispatchFetch(origin+'/api/login',{method:'POST',headers:{Origin:origin},body:'{"password":"viewer"}'});const cookie=login.headers.get('set-cookie').split(';')[0];
  const control=(endpoint,body,headers={Cookie:cookie,Origin:origin})=>mf.dispatchFetch(origin+'/api/'+endpoint,{method:'POST',headers,body:JSON.stringify(body)});
  assert.equal((await control('port',{port:'c1',action:'off'},{Origin:origin,Authorization:'Bearer device'})).status,401);
  assert.equal((await control('port',{port:'c1',action:'off'},{Origin:'https://evil.example',Cookie:cookie})).status,403);
  assert.equal((await control('port',{port:'c1',action:'off'})).status,503);
  const response=await mf.dispatchFetch(origin+'/api/device',{headers:{Upgrade:'websocket',Authorization:'Bearer device'}});const ws=response.webSocket;ws.accept();
  const nextCommand=()=>new Promise(resolve=>ws.addEventListener('message',function receive(e){const d=JSON.parse(e.data);if(d.type==='command'){ws.removeEventListener('message',receive);resolve(d);}}));
  const firstMessage=nextCommand();let completed=false;const first=control('port',{port:'c1',action:'off'}).then(r=>{completed=true;return r;});const command=await firstMessage;assert.equal(completed,false);assert.equal(command.action,'port');assert.equal(command.expiresAt-command.issuedAt,10000);assert.equal((await control('set',{piid:13,value:1})).status,409);
  ws.send(JSON.stringify({type:'command_result',id:command.id,ok:true}));assert.deepEqual(await (await first).json(),{ok:true});
  const settings={type:'settings',version:1,settings:{'16':15,'21':50532111},protocolExtend:50532111,deviceModel:'AD140',firmwareVersion:'test'};ws.send(JSON.stringify(settings));
  // A ping roundtrip via device is prohibited, so wait for HTTP status to observe settings.
  for(let i=0;i<20;i++){const status=await (await mf.dispatchFetch(origin+'/api/status',{headers:{Cookie:cookie}})).json();if(status.device_model==='AD140')break;await new Promise(r=>setTimeout(r,10));}
  const protocolMessage=nextCommand();const protocol=control('protocol',{port:'c1',protocol:'pd',action:'off'});const protocolCommand=await protocolMessage;assert.equal(protocolCommand.action,'set');assert.equal(protocolCommand.params.piid,21);ws.send(JSON.stringify({type:'command_result',id:protocolCommand.id,ok:false,error:'BLE failure'}));assert.equal((await protocol).status,502);
  const timeoutMessage=nextCommand();const timeout=control('enable',{enabled:true});await timeoutMessage;const timeoutResult=await timeout;assert.equal(timeoutResult.status,504);assert.match((await timeoutResult.json()).error,/timed out/);
  const disconnectedMessage=nextCommand();const disconnected=control('enable',{enabled:false});await disconnectedMessage;ws.close();assert.equal((await disconnected).status,503);
 }finally{await mf.dispose();}
});

test('Workers runtime protects console HTML while login and assets stay public',async()=>{
 const mf=new Miniflare(convertV4MiniflareOptions({modules:['worker.js','room.js','protocol.js','login-limiter.js','history.js','history-api.js','energy.js'].map(name=>({type:'ESModule',path:fileURLToPath(new URL('../src/'+name,import.meta.url))})),compatibilityDate:'2026-11-01',durableObjects:{ROOM:{className:'TelemetryRoom',useSQLite:true},LOGIN_LIMITER:{className:'LoginLimiter',useSQLite:true}},serviceBindings:{ASSETS:()=>new Response('asset shell')},bindings:{VIEWER_PASSWORD:'viewer',DEVICE_TOKEN:'device',SESSION_SECRET:'secret'}}));
 try{const origin='https://console.example';for(const path of ['/','/phone.html','/config','/index.html','/phone/','/%70hone.html']){const r=await mf.dispatchFetch(origin+path,{redirect:'manual'});assert.equal(r.status,302);assert.equal(r.headers.get('location'),'/login.html');}
 for(const path of ['/login.html','/login','/assets/app.js','/style.css'])assert.equal((await mf.dispatchFetch(origin+path)).status,200);
 const login=await mf.dispatchFetch(origin+'/api/login',{method:'POST',headers:{Origin:origin},body:'{"password":"viewer"}'});const cookie=login.headers.get('set-cookie').split(';')[0];const root=await mf.dispatchFetch(origin+'/',{headers:{Cookie:cookie}});assert.equal(root.status,200);assert.equal(await root.text(),'asset shell');
 }finally{await mf.dispose();}
});
