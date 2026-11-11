import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { signSession, verifySession } from '../src/worker.js';
import { validateTelemetry } from '../src/protocol.js';
import { TelemetryRoom } from '../src/room.js';
const sample = () => ({type:'telemetry',version:1,seq:1,uptimeMs:100,bleConnected:true,ports:['c1','c2','c3','a'].map(id=>({id,voltage:5,current:1,power:5,active:true,valid:true,protocol:'PD'}))});
const env={SESSION_SECRET:'test-session-secret',DEVICE_TOKEN:'device-only',VIEWER_PASSWORD:'viewer-only',LOGIN_LIMITER:{idFromName:x=>x,get:()=>({fetch:async()=>Response.json({allowed:true})})}};
test('strict schema rejects unknown/private fields, duplicates, invalid values',()=>{
 assert.deepEqual(validateTelemetry(sample()),sample());
 for(const change of [s=>s.token='private',s=>s.ports[0].mac='x',s=>s.ports[1].id='c1',s=>s.seq=-1,s=>s.ports[0].power=Infinity,s=>s.ports[0].valid=1]) {const s=sample();change(s);assert.throws(()=>validateTelemetry(s));}
});
test('telemetry accepts explicit connection phases while rejecting invalid or inconsistent phases',()=>{const s=sample();s.bleConnected=false;s.blePhase='scanning';assert.deepEqual(validateTelemetry(s),s);assert.throws(()=>validateTelemetry({...s,blePhase:'unknown'}));assert.throws(()=>validateTelemetry({...s,bleConnected:true}));});
test('signed sessions expire and cannot be forged',async()=>{const token=await signSession(env.SESSION_SECRET,1000);assert.equal(await verifySession(token,env.SESSION_SECRET,1001),true);assert.equal(await verifySession(token,env.SESSION_SECRET,1000+12*3600*1000),false);assert.equal(await verifySession(token+'x',env.SESSION_SECRET,1001),false);});
test('login requires same origin and separate viewer password',async()=>{
 const req=(origin,password)=>new Request('https://cloud.example/api/login',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({password})});
 assert.equal((await worker.fetch(req('https://evil.test','viewer-only'),env)).status,403);
 assert.equal((await worker.fetch(req('https://cloud.example','device-only'),env)).status,401);
 const res=await worker.fetch(req('https://cloud.example','viewer-only'),env);assert.equal(res.status,200);assert.match(res.headers.get('set-cookie'),/HttpOnly; Secure; SameSite=Strict/);
});
test('device token never authenticates viewer and viewer cookie never authenticates device',async()=>{
 assert.equal((await worker.fetch(new Request('https://cloud.example/api/live',{headers:{Origin:'https://cloud.example',Authorization:'Bearer device-only',Upgrade:'websocket'}}),env)).status,401);
 const token=await signSession(env.SESSION_SECRET);
 assert.equal((await worker.fetch(new Request('https://cloud.example/api/device',{headers:{Cookie:`cuktech_session=${token}`,Upgrade:'websocket'}}),env)).status,401);
});
class Socket {constructor(a){this.a=a;this.sent=[];this.closed=null;}serializeAttachment(a){this.a=structuredClone(a);}deserializeAttachment(){return structuredClone(this.a);}send(s){this.sent.push(JSON.parse(s));}close(code,reason){this.closed=[code,reason];}}
const state=(sockets=[])=>({getWebSockets:()=>sockets,acceptWebSocket:s=>sockets.push(s)});
test('room restores attached latest, coordinates rates, replaces producer',()=>{
 const old=new Socket({role:'device',latest:{...sample(),receivedAt:123},lastAcceptedAt:0});const viewer=new Socket({role:'viewer',expiresAt:Date.now()+100000});const room=new TelemetryRoom(state([old,viewer]));
 assert.equal(room.latest.receivedAt,123);
 const replacement=new Socket();room.connect(replacement,'device');assert.equal(old.closed[0],1000);assert.deepEqual(replacement.sent.at(-1),{type:'rate',intervalMs:1000});
 room.webSocketClose(viewer);assert.deepEqual(replacement.sent.at(-1),{type:'rate',intervalMs:30000});
});
test('room rejects viewer uploads and malformed/oversize device messages',()=>{
 for(const payload of ['null','1','[]','{}','x'.repeat(4097),JSON.stringify({...sample(),secret:'x'})]){const s=new Socket({role:'device'});const room=new TelemetryRoom(state([s]));room.webSocketMessage(s,payload);assert.equal(s.closed[0],1008);}
 const v=new Socket({role:'viewer',expiresAt:Date.now()+100000});new TelemetryRoom(state([v])).webSocketMessage(v,JSON.stringify(sample()));assert.equal(v.closed[0],1008);
});
test('room forwards only accepted snapshots and recovers without database',()=>{
 const d=new Socket({role:'device'}),v=new Socket({role:'viewer',expiresAt:Date.now()+100000});const room=new TelemetryRoom(state([d,v]));room.webSocketMessage(d,JSON.stringify(sample()));assert.equal(v.sent.at(-1).type,'telemetry');assert.equal(typeof v.sent.at(-1).receivedAt,'number');assert.ok(JSON.stringify(d.a).length<2048);
 room.webSocketMessage(d,JSON.stringify({...sample(),seq:2}));assert.equal(v.sent.filter(x=>x.type==='telemetry').length,1);
 room.webSocketClose(d);assert.equal(v.sent.at(-1).type,'status');assert.equal(v.sent.at(-1).deviceConnected,false);
});
test('one-second live samples tolerate moderate network jitter without allowing bursts',()=>{
 const original=Date.now;let now=100000;Date.now=()=>now;
 try{const d=new Socket({role:'device'}),v=new Socket({role:'viewer',expiresAt:200000});const room=new TelemetryRoom(state([d,v]));
  room.webSocketMessage(d,JSON.stringify(sample()));now+=400;room.webSocketMessage(d,JSON.stringify({...sample(),seq:2}));
  assert.equal(v.sent.filter(x=>x.type==='telemetry').length,1);
  now+=450;room.webSocketMessage(d,JSON.stringify({...sample(),seq:3}));
  assert.equal(v.sent.filter(x=>x.type==='telemetry').length,2);
 }finally{Date.now=original;}
});
test('expired viewers close before receiving data or sending ping',()=>{
 const v=new Socket({role:'viewer',expiresAt:Date.now()-1,sessionId:'expired'});const room=new TelemetryRoom(state([v]));room.broadcast({type:'status',deviceConnected:true});assert.equal(v.sent.length,0);assert.equal(v.closed[0],1008);
 const v2=new Socket({role:'viewer',expiresAt:Date.now()-1,sessionId:'expired'});new TelemetryRoom(state([v2])).webSocketMessage(v2,'{"type":"ping"}');assert.equal(v2.sent.length,0);assert.equal(v2.closed[0],1008);
});
test('logout retires only same session sockets and persists revocation',async()=>{
 const map=new Map();const storage={get:async k=>map.get(k),put:async(k,v)=>map.set(k,v)};
 const a=new Socket({role:'viewer',sessionId:'one',expiresAt:Date.now()+10000}),b=new Socket({role:'viewer',sessionId:'two',expiresAt:Date.now()+10000});const room=new TelemetryRoom({...state([a,b]),storage});
 const res=await room.fetch(new Request('https://room/logout',{method:'POST',headers:{'X-Session-Id':'one','X-Session-Expires':String(Date.now()+10000)}}));assert.equal(res.status,200);assert.equal(a.closed[0],1008);assert.equal(b.closed,null);assert.ok(map.get('revoked:one'));
});
test('login limit survives object reconstruction using durable storage',async()=>{
 const {LoginLimiter}=await import('../src/login-limiter.js');const map=new Map();
 const storage={get:async k=>map.get(k),put:async(k,v)=>map.set(k,v),delete:async k=>map.delete(k),setAlarm:async()=>{}};storage.transaction=async fn=>fn(storage);
 const state={storage};const request=()=>new Request('https://limiter/check',{method:'POST',body:'{"success":false}'});
 for(let i=0;i<5;i++)assert.equal((await (await new LoginLimiter(state).fetch(request())).json()).allowed,true);
 const result=await (await new LoginLimiter(state).fetch(request())).json();assert.equal(result.allowed,false);assert.ok(result.retryAfter>0);
});
