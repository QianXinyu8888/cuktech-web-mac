import { HistoryStore } from './history.js';
import { validateTelemetry, validateControl, validateSettings, validateCommandResult, decodeSwitches, validateHistoryBatch, validateAutomationState, mergeAutomation, historyMethods, MAX_HISTORY_MESSAGE_BYTES, MAX_MESSAGE_BYTES } from './protocol.js';
const LIVE_INTERVAL_MS = 1000;
const IDLE_INTERVAL_MS = 30000;
const STATUS_FRESHNESS_MS = IDLE_INTERVAL_MS + 15000;
class DeviceRoom {
 constructor(state,deviceId='default',viewers=null){
  this.deviceId=deviceId;this.state=state;this.viewers=viewers??new Set();this.producer=null;this.latest=null;this.settings=null;this.pending=null;
  for(const socket of state.getWebSockets()){
   const a=socket.deserializeAttachment();
   if(a?.role==='device'){this.producer=socket;this.latest=a.latest??null;this.settings=a.settings??null;this.automationFresh=!!a.automationProgress;if(a.automationProgress)this._automationState=a.automationProgress;}
   else if(a?.role==='viewer')this.viewers.add(socket);
  }
 }
 async fetch(request){
  const path=new URL(request.url).pathname;
  if(['/api/port-modes','/api/charge-limits'].includes(path)){
   if(request.method==='GET')return Response.json(this.automationResponse(path));
   if(request.method!=='POST')return Response.json({ok:false,error:'Method not allowed'},{status:405});
   if(!this.producer)return Response.json({ok:false,error:'Device disconnected'},{status:503});
   if(!this.automationFresh||!this.automationState)return Response.json({ok:false,error:'Awaiting gateway automation state'},{status:503});
   let params;try{params=mergeAutomation(path.split('/').at(-1),await request.json(),this.automationState);}catch(error){return Response.json({ok:false,error:error.message},{status:400});}
   return this.command({action:'automation',params},{onSuccess:()=>{const source=this.pending?.automationState??this.automationState;const next={...source,chargeLimits:Object.fromEntries(Object.entries(source.chargeLimits).map(([p,e])=>[p,{...e,...params.chargeLimits[p]}])),permanent:params.permanent,fullOff:params.fullOff};this.persistAutomation(next);return this.automationResponse(path);}});
  }
  if(historyMethods(path)){if(!historyMethods(path).includes(request.method))return Response.json({ok:false,error:'Method not allowed'},{status:405});return (await this.history.handle(request,this.deviceId))??new Response('Not found',{status:404});}
  if(path==='/status')return Response.json(this.publicStatus());
  if(path==='/devices')return Response.json({ok:true,devices:[{id:'default',name:this.settings?.deviceModel||'CUKTECH',connected:this.publicStatus().connected,is_primary:true}]});
  if(path.startsWith('/control/')){let command;try{command=validateControl(path.split('/').at(-1),await request.json(),this.settings?.protocolExtend);}catch(error){return Response.json({ok:false,error:error.message},{status:400});}return this.command(command);}
  if(path==='/logout'){
   const id=request.headers.get('X-Session-Id'),expiry=Number(request.headers.get('X-Session-Expires'));
   await this.state.storage.put('revoked:'+id,expiry);
   await this.state.storage.setAlarm?.(expiry);
   for(const socket of [...this.viewers])if(socket.deserializeAttachment()?.sessionId===id){socket.close(1008,'Signed out');this.disconnect(socket);}
   return new Response(null,{status:200});
  }
  if(path==='/session'){const key='revoked:'+request.headers.get('X-Session-Id');const expiry=await this.state.storage.get(key);return new Response(null,{status:expiry && expiry>Date.now()?401:200});}

  if(request.headers.get('Upgrade')?.toLowerCase()!=='websocket')return new Response('WebSocket required',{status:426});
  const role=request.headers.get('X-Room-Role');if(!['device','viewer'].includes(role))return new Response('Forbidden',{status:403});
  if(role==='viewer'){const expiry=Number(request.headers.get('X-Session-Expires'));const revoked=await this.state.storage.get('revoked:'+request.headers.get('X-Session-Id'));if(!Number.isFinite(expiry)||expiry<=Date.now()||revoked>Date.now())return new Response('Unauthorized',{status:401});}
  const pair=new WebSocketPair();this.connect(pair[1],role,{sessionId:request.headers.get('X-Session-Id'),expiresAt:Number(request.headers.get('X-Session-Expires')),credentialVersion:Number(request.headers.get('X-Credential-Version'))||undefined});return new Response(null,{status:101,webSocket:pair[0]});
 }
 validViewer(socket){const a=socket.deserializeAttachment();if(a?.role==='viewer' && (!Number.isFinite(a.expiresAt)||a.expiresAt<=Date.now())){socket.close(1008,'Session expired');this.disconnect(socket);return false;}return true;}
 send(socket,data){if(!this.validViewer(socket))return;try{socket.send(JSON.stringify(data));}catch{this.disconnect(socket);}}
 broadcast(data){for(const socket of [...this.viewers])this.send(socket,{...data,device:this.deviceId});}
 rate(){if(this.producer)this.send(this.producer,{type:'rate',intervalMs:this.viewers.size?LIVE_INTERVAL_MS:IDLE_INTERVAL_MS});}
 connect(socket,role,session={}){
  this.state.acceptWebSocket(socket);
  socket.serializeAttachment({role,...session,...(role==='device'?{deviceId:this.deviceId}: {})});
  if(role==='device'){
   const old=this.producer;this.failPending('Device replaced',503);this.producer=socket;this.latest=null;this.settings=null;this.automationFresh=false;
   if(old){old.serializeAttachment({role:'retired'});old.close(1000,'Producer replaced');}
   this.broadcast({type:'status',deviceConnected:true});this.rate();
  }else{
   this.viewers.add(socket);this.send(socket,{type:'status',device:this.deviceId,deviceConnected:!!this.producer});
   if(this.latest)this.send(socket,{...this.latest,device:this.deviceId});this.send(socket,{type:'init',device:this.deviceId,...(this.devicesProvider?{devices:this.devicesProvider()}:{}),data:this.publicStatus()});this.rate();
  }
 }
 webSocketMessage(socket,message){
  if(!this.validViewer(socket))return;
  const a=socket.deserializeAttachment();
  if(typeof message!=='string'||new TextEncoder().encode(message).length>MAX_HISTORY_MESSAGE_BYTES){socket.close(1008,'Invalid message');this.disconnect(socket);return;}
  let data;try{data=JSON.parse(message);}catch{socket.close(1008,'Invalid JSON');this.disconnect(socket);return;}
  if(data?.type!=='history_batch'&&new TextEncoder().encode(message).length>MAX_MESSAGE_BYTES){socket.close(1008,'Message too large');this.disconnect(socket);return;}
  if(a?.role==='viewer'){
   if(data?.type==='ping'&&Object.keys(data).length===1){this.send(socket,{type:'pong'});return;}
   socket.close(1008,'Read only');this.disconnect(socket);return;
  }
  if(a?.role!=='device'||socket!==this.producer){socket.close(1008,'Inactive producer');return;}
  if(data?.type==='automation_state'){try{validateAutomationState(data);if(this.pending?.action==='automation')this.pending.automationState=data;else this.persistAutomation(data);this.automationFresh=true;this.broadcast(data);}catch{socket.close(1008,'Invalid automation state');this.disconnect(socket);}return;}
  if(data?.type==='history_batch'){try{validateHistoryBatch(data);}catch{socket.close(1008,'Invalid history batch');this.disconnect(socket);return;}const history=this.history,windows=structuredClone(history.windows);try{const result=this.state.storage.transactionSync(()=>history.ingestBatch(data.samples,this.deviceId));this.send(socket,{type:'history_ack',id:data.id,accepted:result.accepted});}catch{history.windows=windows;socket.close(1011,'History storage failed');this.disconnect(socket);}return;}
  if(data?.type==='command_result'){try{validateCommandResult(data);}catch{socket.close(1008,'Invalid result');this.disconnect(socket);return;}const pending=this.pending;if(pending&&data.id===pending.id){if(Date.now()>=pending.expiresAt)this.failPending('Command timed out',504);else this.finishPending(data.ok?{ok:true}:{ok:false,error:data.error||'Device rejected command'},data.ok?200:502);}return;}
  if(data?.type==='settings'){try{validateSettings(data);const attachment={...a,settings:data};if(new TextEncoder().encode(JSON.stringify(attachment)).length>=2048)throw new Error('Attachment too large');this.settings=data;socket.serializeAttachment(attachment);this.broadcast({type:'settings',...data});this.broadcast({type:'mac-status',data:this.publicStatus()});}catch{socket.close(1008,'Invalid settings');this.disconnect(socket);}return;}
  try{validateTelemetry(data);}catch{socket.close(1008,'Invalid telemetry');this.disconnect(socket);return;}
  const now=Date.now(), interval=this.viewers.size?LIVE_INTERVAL_MS:IDLE_INTERVAL_MS;
  if(a.lastAcceptedAt!==undefined && now-a.lastAcceptedAt<interval)return;
  this.latest={...data,receivedAt:now};
  const attachment={...a,role:'device',lastAcceptedAt:now,latest:this.latest,...(this.settings?{settings:this.settings}:{}),...(a.automationProgress?{automationProgress:a.automationProgress}:{})};
  if(new TextEncoder().encode(JSON.stringify(attachment)).length>=2048){socket.close(1008,'Snapshot too large');this.disconnect(socket);return;}
  socket.serializeAttachment(attachment);this.broadcast({type:'mac-status',data:this.publicStatus()});this.broadcast(this.latest);
 }
 disconnect(socket){
  if(socket===this.producer){this.failPending('Device disconnected',503);this.producer=null;this.latest=null;socket.serializeAttachment({role:'retired'});this.broadcast({type:'status',deviceConnected:false});}
  if(this.viewers.delete(socket)){socket.serializeAttachment({role:'retired'});this.rate();this.onViewerChange?.();}
 }
 get automationState(){return this._automationState??(this.state.storage?.sql?this.history.meta('automation_state',this.deviceId,null):null);}
 persistAutomation(state){
  validateAutomationState(state);
  const config=s=>({chargeLimits:Object.fromEntries(Object.entries(s.chargeLimits).sort(([a],[b])=>a.localeCompare(b)).map(([p,e])=>[p,{wh:e.wh,mode:e.mode}])),permanent:[...s.permanent].sort(),fullOff:Object.fromEntries(Object.entries(s.fullOff).sort(([a],[b])=>a.localeCompare(b)))});
  const attachment=this.producer?{...this.producer.deserializeAttachment(),automationProgress:state}:null;
  if(attachment&&new TextEncoder().encode(JSON.stringify(attachment)).length>=2048)throw new Error('Automation attachment too large');
  const previous=this.automationState, nextConfig=config(state);
  if(!previous||JSON.stringify(config(previous))!==JSON.stringify(nextConfig)){
   const stored={...state,chargeLimits:Object.fromEntries(Object.entries(state.chargeLimits).map(([p,e])=>[p,{...e,sessionWh:0,fired:false,pending:false,error:''}]))};
   this.state.storage.transactionSync(()=>{this.history.setMeta('automation_state',stored,this.deviceId);this.history.setMeta('charge_limits',nextConfig.chargeLimits,this.deviceId);this.history.setMeta('permanent_ports',nextConfig.permanent,this.deviceId);this.history.setMeta('full_off_ports',nextConfig.fullOff,this.deviceId);});
  }
  this._automationState=state;this.automationReceivedAt=Date.now();
  if(attachment)this.producer.serializeAttachment(attachment);

 }
 automationResponse(path){const s=this.automationState,common={ok:true,configured:!!s,gateway_connected:!!this.producer,state_fresh:!!this.producer&&!!this.automationFresh};if(path.endsWith('charge-limits'))return {...common,limits:s?Object.fromEntries(Object.entries(s.chargeLimits).map(([p,e])=>[p,{wh:e.wh,mode:e.mode,session_wh:e.sessionWh,fired:e.fired,pending:e.pending,error:e.error}])):{}};return {...common,permanent_ports:s?.permanent??[],full_off_ports:s?.fullOff??{}};}
 get history(){return this._history??=new HistoryStore(this.state.storage.sql);}
 publicStatus(){
  const settings=this.settings?.settings??{}, value=this.settings?.protocolExtend??0;
  const age=Date.now()-(this.latest?.receivedAt??NaN);
  const connected=!!this.producer&&!!this.latest?.bleConnected&&age>=0&&age<=STATUS_FRESHNESS_MS;
  const ports=Object.fromEntries(['c1','c2','c3','a'].map((id,index)=>{const p=this.latest?.ports.find(p=>p.id===id);return [String(index+1),{voltage:p?.voltage??0,current:p?.current??0,power:p?.power??0,active:connected&&(p?.active??false),valid:connected&&(p?.valid??false),protocol:p?.protocol??'idle',enabledKnown:connected&&Object.hasOwn(settings,'16'),enabled:!!((settings['16']??0)&2**index)}];}));
  const automation=this.automationState;
  return {...(automation?{permanent_ports:automation.permanent,full_off_ports:automation.fullOff}:{}),connected,authenticated:connected,connection:{phase:connected?'connected':'disabled'},ports,settings,protocol_extend:value,protocol_switches:decodeSwitches(value),device_model:this.settings?.deviceModel??'',firmware_version:this.settings?.firmwareVersion??'',gateway_connected:!!this.producer,receivedAt:this.latest?.receivedAt??null};
 }
 command(command,{onSuccess}={}){
  if(this.pending)return Promise.resolve(Response.json({ok:false,error:'Another command is pending'},{status:409}));
  if(!this.producer)return Promise.resolve(Response.json({ok:false,error:'Device disconnected'},{status:503}));
  const id=crypto.randomUUID(),issuedAt=Date.now(),expiresAt=issuedAt+10000;
  return new Promise(resolve=>{const timer=setTimeout(()=>this.failPending('Command timed out',504),10000);this.pending={id,expiresAt,resolve,timer,action:command.action,onSuccess};try{this.producer.send(JSON.stringify({type:'command',id,issuedAt,expiresAt,...command}));}catch{this.failPending('Device disconnected',503);}});
 }
 finishPending(body,status){const pending=this.pending;if(!pending)return;if(body.ok&&pending.onSuccess){try{body=pending.onSuccess();}catch{body={ok:false,error:'Confirmed rule could not be persisted'};status=503;}}this.pending=null;clearTimeout(pending.timer);pending.resolve(Response.json(body,{status}));}
 failPending(error,status){this.finishPending({ok:false,error},status);}
 async alarm(){const entries=await this.state.storage.list({prefix:'revoked:'});let next=Infinity;for(const [key,expiry] of entries){if(expiry<=Date.now())await this.state.storage.delete(key);else next=Math.min(next,expiry);}if(Number.isFinite(next))await this.state.storage.setAlarm(next);}
 webSocketClose(socket){this.disconnect(socket);try{socket.close(1000,'Closed');}catch{}}
 webSocketError(socket){this.disconnect(socket);try{socket.close(1011,'Socket error');}catch{}}
}


export class TelemetryRoom extends DeviceRoom {
 constructor(state){
  const sockets=state.getWebSockets();
  const filtered=id=>new Proxy(state,{get(target,key){if(key==='getWebSockets')return ()=>sockets.filter(s=>{const a=s.deserializeAttachment();return a?.role==='device'&&(a.deviceId??'default')===id;});const value=target[key];return typeof value==='function'?value.bind(target):value;}});
  super(filtered('default'));
  this.realState=state;this.filteredState=filtered;this.devicesProvider=()=>this.list();this.rooms=new Map([['default',this]]);
  for(const s of sockets){const a=s.deserializeAttachment();if(a?.role==='viewer')this.viewers.add(s);else if(a?.role==='device'&&(a.deviceId??'default')!=='default')this.deviceRoom(a.deviceId);}
 }
 deviceRoom(id){if(!this.rooms.has(id)){const child=new DeviceRoom(this.filteredState(id),id,this.viewers);child.onViewerChange=()=>{for(const room of this.rooms.values())room.rate();};this.rooms.set(id,child);}return this.rooms.get(id);}
 initRegistry(){if(this.registryReady)return;this.state.storage.sql.exec(`CREATE TABLE IF NOT EXISTS cloud_devices (id TEXT PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT UNIQUE, credential_version INTEGER NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, is_primary INTEGER NOT NULL)`);this.state.storage.sql.exec("INSERT OR IGNORE INTO cloud_devices VALUES ('default','CUKTECH',NULL,1,'active',?1,?1,1)",Date.now());this.registryReady=true;}
 row(id){if(typeof this.state.storage?.sql?.exec!=='function')return id==='default'?{id,status:'active',credential_version:1}:undefined;this.initRegistry();return this.state.storage.sql.exec('SELECT * FROM cloud_devices WHERE id=?',id).toArray()[0];}
 list(){if(typeof this.state.storage?.sql?.exec!=='function')return [{id:'default',name:this.settings?.deviceModel||'CUKTECH',connected:this.publicStatus().connected,is_primary:true}];this.initRegistry();return this.state.storage.sql.exec("SELECT id,name,status,is_primary FROM cloud_devices WHERE status='active' ORDER BY is_primary DESC,created_at").toArray().map(r=>{const room=this.deviceRoom(r.id),status=room.publicStatus();return {id:r.id,name:r.name,connected:status.connected,gateway_connected:status.gateway_connected,is_primary:!!r.is_primary};});}
 directory(){const devices=this.list();for(const viewer of this.viewers)for(const d of devices)this.send(viewer,{type:'init',device:d.id,devices,data:this.deviceRoom(d.id).publicStatus()});}
 async fetch(request){
  const url=new URL(request.url),path=url.pathname;
  if(path==='/registry/authorize'){
   this.initRegistry();const hash=request.headers.get('X-Token-Hash');const legacy=request.headers.get('X-Legacy')==='1';const r=legacy?this.row('default'):this.state.storage.sql.exec("SELECT * FROM cloud_devices WHERE token_hash=?",hash).toArray()[0];
   if(!r||r.status!=='active'||(legacy&&r.token_hash))return new Response(null,{status:401});return Response.json({id:r.id,version:r.credential_version});
  }
  if(path==='/registry/devices')return Response.json({ok:true,devices:this.list()});
  if(path.startsWith('/registry/')){
   this.initRegistry();let body;try{body=await request.json();}catch{return Response.json({ok:false,error:'Invalid JSON'},{status:400});}
   if(!body||typeof body!=='object'||Array.isArray(body))return Response.json({ok:false,error:'Invalid request'},{status:400});
   const parts=path.split('/'),action=parts.at(-1),id=parts[2];
   if(action==='register'){
    if(Object.keys(body).join()!=='name'||typeof body.name!=='string'||!body.name.trim()||body.name.length>80)return Response.json({ok:false,error:'Invalid name'},{status:400});
    if(this.list().length>=8)return Response.json({ok:false,error:'Device limit reached'},{status:409});
    const id=crypto.randomUUID(),token=makeToken(),hash=await hashToken(token),now=Date.now();this.state.storage.sql.exec("INSERT INTO cloud_devices VALUES (?,?,?,1,'active',?,?,0)",id,body.name.trim(),hash,now,now);this.directory();return Response.json({ok:true,device:{id,name:body.name.trim(),is_primary:false},token},{status:201});
   }
   const r=this.row(id);if(!r||r.status!=='active')return Response.json({ok:false,error:'Unknown device'},{status:404});
   if(action==='rename'){
    if(Object.keys(body).join()!=='name'||typeof body.name!=='string'||!body.name.trim()||body.name.length>80)return Response.json({ok:false,error:'Invalid name'},{status:400});this.state.storage.sql.exec('UPDATE cloud_devices SET name=?,updated_at=? WHERE id=?',body.name.trim(),Date.now(),id);this.directory();return Response.json({ok:true,device:{id,name:body.name.trim(),is_primary:!!r.is_primary}});
   }
   if(!['rotate-token','revoke'].includes(action)||Object.keys(body).length)return Response.json({ok:false,error:'Invalid request'},{status:400});
   const token=action==='rotate-token'?makeToken():null,hash=token?await hashToken(token):null;this.state.storage.sql.exec('UPDATE cloud_devices SET token_hash=?,credential_version=credential_version+1,status=?,updated_at=? WHERE id=?',hash,token?'active':'disabled',Date.now(),id);
   const target=this.deviceRoom(id);if(target.producer){const socket=target.producer;target.disconnect(socket);socket.close(1008,'Credential revoked');}this.directory();return Response.json({ok:true,...(token?{token}: {})});
  }
  if(path==='/devices'){const devices=this.list();if(url.searchParams.get('include_archived')==='1'){this.initRegistry();devices.push(...this.state.storage.sql.exec("SELECT id,name,status,is_primary FROM cloud_devices WHERE status='disabled' ORDER BY updated_at DESC").toArray().map(r=>({id:r.id,name:r.name,status:'disabled',is_primary:!!r.is_primary})));}return Response.json({ok:true,devices});}
  const id=request.headers.get('X-Device-Id')??'default';
  if(path==='/connect'&&request.headers.get('X-Room-Role')==='viewer'){
   const response=await super.fetch(request);if(response.status===101){this.directory();for(const room of this.rooms.values())room.rate();}return response;
  }
  if(!['/session','/logout'].includes(path)){
   const row=this.row(id);if(!row)return Response.json({ok:false,error:'Unknown device'},{status:404});
   if(row.status!=='active'&&(!historyMethods(path)||request.method!=='GET'))return Response.json({ok:false,error:'Device revoked'},{status:409});
   if(path==='/connect'&&(row.status!=='active'||Number(request.headers.get('X-Credential-Version'))!==row.credential_version))return new Response(null,{status:401});
   const target=this.deviceRoom(id);if(target!==this)return target.fetch(request);
  }
  return super.fetch(request);
 }
 webSocketMessage(socket,message){const a=socket.deserializeAttachment();if(a?.role==='device'){
   const row=this.row(a.deviceId??'default');if(!row||row.status!=='active'||(a.credentialVersion!=null&&a.credentialVersion!==row.credential_version)){socket.close(1008,'Credential revoked');return;}
   const target=this.deviceRoom(a.deviceId??'default');if(target!==this)return target.webSocketMessage(socket,message);
  }return super.webSocketMessage(socket,message);}
 disconnect(socket){const wasViewer=this.viewers.has(socket);super.disconnect(socket);if(wasViewer&&this.rooms)for(const room of this.rooms.values())room.rate();}
 webSocketClose(socket){const wasViewer=socket.deserializeAttachment()?.role==='viewer';if(wasViewer){super.webSocketClose(socket);for(const room of this.rooms.values())room.rate();return;}const id=socket.deserializeAttachment()?.deviceId;const target=id&&this.deviceRoom(id);if(target&&target!==this)return target.webSocketClose(socket);return super.webSocketClose(socket);}
 webSocketError(socket){const id=socket.deserializeAttachment()?.deviceId;const target=id&&this.deviceRoom(id);if(target&&target!==this)return target.webSocketError(socket);return super.webSocketError(socket);}
}
function makeToken(){const bytes=crypto.getRandomValues(new Uint8Array(32));return btoa(String.fromCharCode(...bytes)).replaceAll('+','-').replaceAll('/','_').replaceAll('=','');}
async function hashToken(token){const bytes=new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(token)));return [...bytes].map(x=>x.toString(16).padStart(2,'0')).join('');}
