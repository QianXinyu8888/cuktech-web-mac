export const MAX_MESSAGE_BYTES = 2048;
const keys=(o,names)=>o && typeof o==='object' && !Array.isArray(o) && Object.keys(o).length===names.length && names.every(k=>Object.hasOwn(o,k));
export function validateTelemetry(data) {
 if(!keys(data,['type','version','seq','uptimeMs','bleConnected','ports']) || data.type!=='telemetry' || data.version!==1 || !Number.isSafeInteger(data.seq) || data.seq<0 || !Number.isFinite(data.uptimeMs) || data.uptimeMs<0 || typeof data.bleConnected!=='boolean' || !Array.isArray(data.ports) || data.ports.length!==4) throw new Error('Invalid telemetry');
 const seen=new Set();
 for(const p of data.ports){
  if(!keys(p,['id','voltage','current','power','active','valid','protocol']) || !['c1','c2','c3','a'].includes(p.id) || seen.has(p.id) || !['voltage','current','power'].every(k=>Number.isFinite(p[k]) && p[k]>=0 && p[k]<=100000) || typeof p.active!=='boolean' || typeof p.valid!=='boolean' || typeof p.protocol!=='string' || new TextEncoder().encode(p.protocol).length>32 || /[\u0000-\u001f\u007f]/.test(p.protocol)) throw new Error('Invalid port');
  seen.add(p.id);
 }
 return data;
}
// Mirrors ble_server/state.py VALID_PIIDS, PIID_RANGES and PROTOCOL_SWITCH_BITS.
export const PIID_RANGES={5:[1,4],6:[0,5],8:[0,1440],9:[0,1440],10:[0,1440],11:[0,1440],12:[0,1440],13:[0,1],15:[0,1],16:[0,15],19:[0,1],20:[0,1],21:[0,0xffffffff]};
export const SWITCH_BITS={c1:{pd:0,pps:1,ufcs:2},c2:{pd:8,pps:9,ufcs:10},c3:{ufcs:16,scp:17},a:{ufcs:24,scp:25}};
const plain=o=>o&&typeof o==='object'&&!Array.isArray(o);
const subset=(o,allowed)=>plain(o)&&Object.keys(o).every(k=>allowed.includes(k));
const integer=v=>{if(typeof v==='boolean'||v===null||v===''||!['number','string'].includes(typeof v)||!Number.isSafeInteger(Number(v)))throw new Error('Expected integer');return Number(v);};
const u32=v=>Number.isInteger(v)&&v>=0&&v<=0xffffffff;
export function decodeSwitches(value){return Object.fromEntries(Object.entries(SWITCH_BITS).map(([p,bits])=>[p,Object.fromEntries(Object.entries(bits).map(([k,b])=>[k,!!(value&2**b)]))]));}
export function encodeSwitches(switches){let value=0;for(const [port,flags] of Object.entries(switches)){if(!Object.hasOwn(SWITCH_BITS,port)||!subset(flags,Object.keys(SWITCH_BITS[port]))||!Object.values(flags).every(v=>typeof v==='boolean'))throw new Error('Unknown protocol switch');if(Object.keys(flags).length&&['c1','c2'].includes(port))value+=2**(port==='c1'?3:11);for(const [name,on]of Object.entries(flags))if(on)value+=2**SWITCH_BITS[port][name];}return value>>>0;}
export function validateControl(endpoint,body,protocolExtend){
 if(!plain(body))throw new Error('Expected JSON object');
 if(endpoint==='port'){if(!keys(body,['port','action'])||typeof body.port!=='string'||typeof body.action!=='string')throw new Error('Expected port/action');const port=body.port.toLowerCase(),action=body.action.toLowerCase();if(!['c1','c2','c3','a','all'].includes(port)||!['on','off'].includes(action))throw new Error('Invalid port/action');return {action:'port',params:{port,action}};}
 if(endpoint==='enable'){if(!keys(body,['enabled'])||typeof body.enabled!=='boolean')throw new Error('Expected enabled boolean');return {action:'ble',params:{enabled:body.enabled}};}
 if(endpoint==='set'){if(!keys(body,['piid','value']))throw new Error('Expected piid/value');const piid=integer(body.piid),value=integer(body.value),range=PIID_RANGES[piid];if(!range||value<range[0]||value>range[1])throw new Error('Invalid piid/value range');return {action:'set',params:{piid,value}};}
 if(endpoint==='protocol'){
  let value;
  if(keys(body,['value'])){value=integer(body.value);if(!u32(value))throw new Error('Invalid protocol value');}
  else if(keys(body,['switches'])){if(!plain(body.switches))throw new Error('Invalid switches');value=encodeSwitches(body.switches);}
  else{if(!subset(body,['port','protocol','action'])||typeof body.port!=='string'||typeof body.protocol!=='string')throw new Error('Expected protocol switch');const port=body.port.toLowerCase(),proto=body.protocol.toLowerCase(),action=body.action??'toggle';if(!Object.hasOwn(SWITCH_BITS,port)||!Object.hasOwn(SWITCH_BITS[port],proto)||!['toggle','on','off'].includes(action))throw new Error('Invalid protocol switch');if(!u32(protocolExtend))throw new Error('Protocol state unavailable');const switches=decodeSwitches(protocolExtend);switches[port][proto]=action==='toggle'?!switches[port][proto]:action==='on';value=encodeSwitches(switches);}
  return {action:'set',params:{piid:21,value}};
 }
 throw new Error('Unknown command');
}
export function validateSettings(data){
 if(!keys(data,['type','version','settings','protocolExtend','deviceModel','firmwareVersion'])||data.type!=='settings'||data.version!==1||!plain(data.settings)||!u32(data.protocolExtend))throw new Error('Invalid settings');
 for(const [key,value]of Object.entries(data.settings)){const range=PIID_RANGES[key];if(!Object.hasOwn(PIID_RANGES,key)||!range||!Number.isInteger(value)||value<range[0]||value>range[1])throw new Error('Invalid setting');}
 for(const key of ['deviceModel','firmwareVersion'])if(typeof data[key]!=='string'||new TextEncoder().encode(data[key]).length>64||/[\u0000-\u001f\u007f]/.test(data[key]))throw new Error('Invalid metadata');
 return data;
}
export function validateCommandResult(data){if(!subset(data,['type','id','ok','error'])||data.type!=='command_result'||typeof data.id!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(data.id)||typeof data.ok!=='boolean'||(data.error!==undefined&&(typeof data.error!=='string'||data.error.length>160||/[\u0000-\u001f\u007f]/.test(data.error))))throw new Error('Invalid command result');return data;}
export const MAX_HISTORY_MESSAGE_BYTES=65536;
export function validateHistoryBatch(data,now=Date.now()/1000){
 if(!keys(data,['type','version','id','samples'])||data.type!=='history_batch'||data.version!==1||typeof data.id!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(data.id)||!Array.isArray(data.samples)||data.samples.length<1||data.samples.length>60)throw new Error('Invalid history batch');
 let previous=-Infinity;for(const sample of data.samples){if(!keys(sample,['timestamp','ports'])||!Number.isFinite(sample.timestamp)||sample.timestamp<1577836800||sample.timestamp>now+300||sample.timestamp<=previous)throw new Error('Invalid history timestamp');if(!Array.isArray(sample.ports))throw new Error('Invalid history ports');const telemetryPorts=sample.ports.map(p=>{if(!plain(p)||Object.hasOwn(p,'enabled')&&typeof p.enabled!=='boolean')throw new Error('Invalid enabled flag');const {enabled,...port}=p;return port;});validateTelemetry({type:'telemetry',version:1,seq:0,uptimeMs:0,bleConnected:true,ports:telemetryPorts});previous=sample.timestamp;}return data;
}
export function historyMethods(path){
 const fixed={
 '/api/sessions':['GET'],'/api/session-filters':['GET'],'/api/energy/stats':['GET'],'/api/energy/protocols':['GET'],
 '/api/sessions/delete':['POST'],'/api/sessions/clear':['POST'],'/api/device-labels':['GET','DELETE'],'/api/battery-profiles':['GET','DELETE'],'/api/learn-curves':['GET'],'/api/session-recording':['GET','POST'],'/api/port-modes':['GET','POST'],'/api/charge-limits':['GET','POST'],'/api/chart':['GET']};
 if(Object.hasOwn(fixed,path))return fixed[path];
 if(/^\/api\/sessions\/\d+\/(points|export)$/.test(path)||/^\/api\/(statistics|export|history)\/[1-4]$/.test(path))return ['GET'];
 if(/^\/api\/sessions\/\d+\/(label|battery)$/.test(path))return ['POST'];
 return null;
}
const RULE_PORTS=['c1','c2','c3','a'];
const limitMode=v=>['once','always'].includes(v);
export function validateAutomationParams(data){
 if(!keys(data,['chargeLimits','permanent','fullOff'])||!keys(data.chargeLimits,RULE_PORTS)||!Array.isArray(data.permanent)||new Set(data.permanent).size!==data.permanent.length||!data.permanent.every(p=>RULE_PORTS.includes(p))||!plain(data.fullOff))throw new Error('Invalid automation config');
 for(const [port,e]of Object.entries(data.chargeLimits))if(!keys(e,['wh','mode'])||!Number.isFinite(e.wh)||e.wh<0||e.wh>1000||!limitMode(e.mode)||data.permanent.includes(port)&&e.wh>0)throw new Error('Invalid charge limit or permanent conflict');
 for(const [port,mode]of Object.entries(data.fullOff))if(!RULE_PORTS.includes(port)||!limitMode(mode)||data.permanent.includes(port))throw new Error('Invalid full-off or permanent conflict');
 return data;
}
export function validateAutomationState(data){
 if(!keys(data,['type','version','chargeLimits','permanent','fullOff'])||data.type!=='automation_state'||data.version!==1||!keys(data.chargeLimits,RULE_PORTS))throw new Error('Invalid automation state');
 for(const e of Object.values(data.chargeLimits)){const base=['wh','mode','sessionWh','fired','pending','error'],extended=[...base,'charging','sessionSec','avgPowerW'];if(!(keys(e,base)||keys(e,extended))||!Number.isFinite(e.sessionWh)||e.sessionWh<0||e.sessionWh>1e9||typeof e.fired!=='boolean'||typeof e.pending!=='boolean'||typeof e.error!=='string'||new TextEncoder().encode(e.error).length>160||/[\u0000-\u001f\u007f]/.test(e.error)||(Object.hasOwn(e,'charging')&&(typeof e.charging!=='boolean'||!Number.isSafeInteger(e.sessionSec)||e.sessionSec<0||!Number.isFinite(e.avgPowerW)||e.avgPowerW<0||e.avgPowerW>100000)))throw new Error('Invalid automation progress');}
 validateAutomationParams({chargeLimits:Object.fromEntries(Object.entries(data.chargeLimits).map(([p,e])=>[p,{wh:e.wh,mode:e.mode}])),permanent:data.permanent,fullOff:data.fullOff});return data;
}
export function mergeAutomation(endpoint,body,state){
 validateAutomationState(state);if(!plain(body))throw new Error('Expected JSON object');
 const result={chargeLimits:Object.fromEntries(Object.entries(state.chargeLimits).map(([p,e])=>[p,{wh:e.wh,mode:e.mode}])),permanent:[...state.permanent],fullOff:{...state.fullOff}};
 if(endpoint==='charge-limits'){
  let updates;if(keys(body,['limits'])){if(!plain(body.limits)||!Object.keys(body.limits).length)throw new Error('limits must be non-empty');updates=body.limits;}
  else{if(!subset(body,['port','wh','mode'])||typeof body.port!=='string')throw new Error('Expected port or limits');updates={[body.port.trim().toLowerCase()]:{wh:body.wh,mode:body.mode}};}
  for(const [raw,entry]of Object.entries(updates)){const port=raw.trim().toLowerCase();if(!RULE_PORTS.includes(port))throw new Error('Unknown port');if(plain(entry)&&!subset(entry,['wh','mode']))throw new Error('Invalid limit keys');const rawWh=plain(entry)?entry.wh:entry,rawMode=plain(entry)?entry.mode:undefined;if(!['number','string'].includes(typeof rawWh)||rawWh==='')throw new Error('wh must be a number');const wh=Number(rawWh);if(!Number.isFinite(wh)||wh<0||wh>1000)throw new Error('wh must be within 0-1000');let mode=result.chargeLimits[port].mode;if(rawMode!==undefined&&rawMode!==null){if(typeof rawMode!=='string'||!limitMode(rawMode.trim().toLowerCase()))throw new Error('Invalid mode');mode=rawMode.trim().toLowerCase();}result.chargeLimits[port]={wh,mode};}
 }else if(endpoint==='port-modes'){
  if(!subset(body,['port','permanent','full_off','mode'])||typeof body.port!=='string')throw new Error('Invalid port modes');const port=body.port.trim().toLowerCase();if(!RULE_PORTS.includes(port))throw new Error('Unknown port');const permanent=body.permanent,fullOff=body.full_off;
  if(permanent==null&&fullOff==null)throw new Error('permanent or full_off required');for(const v of [permanent,fullOff])if(v!=null&&typeof v!=='boolean')throw new Error('Mode flags must be boolean');
  if(permanent===true){if(!result.permanent.includes(port))result.permanent.push(port);delete result.fullOff[port];result.chargeLimits[port].wh=0;}
  if(permanent===false)result.permanent=result.permanent.filter(p=>p!==port);
  if(fullOff===true){const mode=body.mode==null?'once':typeof body.mode==='string'?body.mode.trim().toLowerCase():'';if(!limitMode(mode))throw new Error('Invalid mode');result.fullOff[port]=mode;}
  if(fullOff===false)delete result.fullOff[port];
 }else throw new Error('Unknown automation endpoint');
 result.permanent=RULE_PORTS.filter(p=>result.permanent.includes(p));return validateAutomationParams(result);
}
