import {ChargeSessionDetector,SessionStartGate,integrate} from './energy.js';
import {handleHistoryRequest} from './history-api.js';
export const PORTS=['c1','c2','c3','a'];
export const round=(n,d=2)=>Number((n||0).toFixed(d));
export function signature(s){const proto=(s.protocols||s.protocol||'UNKNOWN').split(',').map(p=>p.trim()).find(p=>!['idle','5v',''].includes(p.toLowerCase()))||'UNKNOWN';const p=s.peak_power_w||0,v=s.max_voltage||s.avg_voltage||0;const bankRound=n=>{const f=Math.floor(n),r=n-f;return r===.5?(f%2?f+1:f):Math.round(n);};return `${proto.toUpperCase()}|${p<5?bankRound(p):bankRound(p/5)*5}|${v>0?[5,9,12,15,20,28].reduce((a,b)=>Math.abs(b-v)<Math.abs(a-v)?b:a):0}`;}
// Four ports share each timestamp; compact arrays avoid repeating field names per second.
const unpack=data=>JSON.parse(data).map(s=>Array.isArray(s)?{timestamp:s[0],ports:s[1].map(p=>({port:p[0],voltage:p[1],current:p[2],power:p[6]??p[1]*p[2],protocol:p[3],active:!!(p[4]&1),valid:!!(p[4]&2),...(p[5]?{sid:p[5]}:{}),...(p[7]?{pid:p[7]}:{})}))}:s);
const pack=data=>JSON.stringify(data.map(s=>[s.timestamp,s.ports.map(p=>[p.port,p.voltage,p.current,p.protocol,(p.active?1:0)|(p.valid?2:0),p.sid||0,p.power,p.pid||0])]));
export class HistoryStore {
 constructor(sql,{now=()=>Date.now()/1000,retentionDays=30}={}){this.sql=sql;this.now=now;this.retentionDays=retentionDays;this.windows=new Map();for(const q of [
 'CREATE TABLE IF NOT EXISTS history_minutes(device TEXT NOT NULL, minute INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(device,minute))',
 'CREATE TABLE IF NOT EXISTS history_sessions(id INTEGER PRIMARY KEY AUTOINCREMENT, device TEXT NOT NULL, port INTEGER NOT NULL, start_time REAL NOT NULL, end_time REAL, data TEXT NOT NULL)',
 'CREATE INDEX IF NOT EXISTS history_session_device_time ON history_sessions(device,start_time)',
 'CREATE TABLE IF NOT EXISTS history_meta(device TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(device,key))'])this.exec(q);}
 exec(q,...args){return this.sql.exec(q,...args);} rows(q,...args){return [...this.exec(q,...args)];}
 meta(key,device='default',fallback=null){const r=this.rows('SELECT value FROM history_meta WHERE device=? AND key=?',device,key)[0];return r?JSON.parse(r.value):fallback;}
 setMeta(key,value,device='default'){this.exec('INSERT INTO history_meta(device,key,value) VALUES(?,?,?) ON CONFLICT(device,key) DO UPDATE SET value=excluded.value',device,key,JSON.stringify(value));}
 save(s,device){const {id,port,start_time,end_time,...data}=s;if(id)this.exec('UPDATE history_sessions SET end_time=?,data=? WHERE id=? AND device=?',end_time,JSON.stringify(data),id,device);else{this.exec('INSERT INTO history_sessions(device,port,start_time,end_time,data) VALUES(?,?,?,?,?)',device,port,start_time,end_time,JSON.stringify(data));s.id=this.rows('SELECT last_insert_rowid() AS id')[0].id;}return s;}
 sessions(device='default',activeOnly=false){return this.rows('SELECT * FROM history_sessions WHERE device=?'+(activeOnly?' AND end_time IS NULL':'')+' ORDER BY start_time DESC,id DESC',device).map(({data,device,...r})=>({...r,...JSON.parse(data)}));}
 get(id,device='default'){return this.sessions(device).find(s=>s.id===id);}
 *iterateReadings(device='default',start=0,end=Infinity){
  const rows=this.exec('SELECT data FROM history_minutes WHERE device=? AND minute>=? AND minute<=? ORDER BY minute',device,Math.floor(start/60),Number.isFinite(end)?Math.floor(end/60):Number.MAX_SAFE_INTEGER);
  for(const row of rows)for(const sample of unpack(row.data))if(sample.timestamp>=start&&sample.timestamp<=end)yield sample;
 }
 readings(device='default',start=0,end=Infinity){return Array.from(this.iterateReadings(device,start,end));}
 points(s,device='default'){if(s.permanent){if(s.end_time!=null)return [];const key=`${device}:${s.id}`;if(!this.windows.has(key)){const last=this.meta('engine',device,{})?.last;if(!Number.isFinite(last))return [];const points=this.readings(device,Math.max(s.start_time,last-3600),last).flatMap(x=>x.ports.filter(p=>p.port===s.port&&p.pid===s.id).map(p=>({timestamp:x.timestamp,voltage:p.voltage,current:p.current,power:p.power,protocol:p.protocol})));this.windows.set(key,points);}return this.windows.get(key);}return Array.from(this.iterateSessionPoints(s,device));}
 *iterateSessionPoints(s,device){
  if(s.permanent)return;
  for(const sample of this.iterateReadings(device,s.start_time,s.end_time??Infinity)){
   const port=sample.ports.find(p=>p.port===s.port&&p.sid===s.id);
   if(port)yield {timestamp:sample.timestamp,voltage:port.voltage,current:port.current,power:port.power,protocol:port.protocol};
  }
 }
 ingestTelemetry(snapshot){return this.ingestBatch([{...snapshot,timestamp:snapshot.timestamp??this.now()}],snapshot.device||'default');}
 ingestBatch(input,device='default'){
 const samples=Array.isArray(input)?input:input.samples;if(!Array.isArray(samples)||samples.length>3600)throw new Error('Invalid history batch');
 // Validate before any writes; timestamps are UNIX seconds (not uptime or milliseconds).
 const normalized=samples.map(s=>{const t=s.timestamp??s.ts;if(!Number.isFinite(t)||t<0||!Array.isArray(s.ports)||s.ports.length!==4)throw new Error('Invalid history sample');const seen=new Set();const ports=s.ports.map(p=>{const port=Number.isInteger(p.port)?p.port:PORTS.indexOf(p.id)+1;if(port<1||port>4||seen.has(port)||!['voltage','current'].every(k=>Number.isFinite(p[k])&&p[k]>=0&&p[k]<=100000))throw new Error('Invalid history port');if(p.power!==undefined&&(!Number.isFinite(p.power)||p.power<0||p.power>100000))throw new Error('Invalid history power');if(p.enabled!==undefined&&typeof p.enabled!=='boolean')throw new Error('Invalid enabled');seen.add(port);return {port,voltage:p.voltage,current:p.current,power:p.power??p.voltage*p.current,protocol:String(p.protocol||''),active:p.active!==false,valid:p.valid!==false,enabled:p.enabled!==false};});return {timestamp:t,ports};}).sort((a,b)=>a.timestamp-b.timestamp);
 const state=this.meta('engine',device,{}),buckets=new Map(),ended=[],dirty=new Map(),sessionCache=new Map(this.sessions(device,true).map(s=>[s.id,s])),permanentPorts=new Set(this.meta('permanent_ports',device,[])),recording=this.meta('recording',device,true);let accepted=0;
 for(const sample of normalized){const t=sample.timestamp;if(state.last!==undefined&&t<=state.last)continue;if(t<this.now()-this.retentionDays*86400)continue;
 for(const p of sample.ports){let ps=state[p.port]||{gate:{},detector:{},pending:[]};const gate=new SessionStartGate(ps.gate),det=new ChargeSessionDetector(ps.detector);const permanent=permanentPorts.has(PORTS[p.port-1]);let s=ps.sid?sessionCache.get(ps.sid):null;
 if(p.valid){det.feed(t,p.voltage,p.current);const point={timestamp:t,...p};ps.pending.push(point);ps.pending=ps.pending.filter(x=>x.timestamp>=t-60);
 if(!s&&!ps.placeholder&&p.active&&p.enabled&&gate.shouldStart(t,det.fast(),p.voltage)){if(!recording){ps.placeholder=true;ps.noLoadSince=null;}else{const pts=ps.pending.filter(x=>x.timestamp>=gate.lastRunStart);s=this.save({port:p.port,start_time:gate.lastRunStart,end_time:null,total_wh:integrate(pts),peak_power_w:Math.max(...pts.map(x=>x.power)),avg_voltage:0,avg_current:0,duration_sec:0,protocol:p.protocol,protocols:p.protocol,permanent,device_name:'',n:pts.length,sum_v:pts.reduce((a,x)=>a+x.voltage,0),sum_i:pts.reduce((a,x)=>a+x.current,0),max_voltage:p.voltage,min_power_w:p.power,counts:{[p.protocol]:pts.length}},device);ps.sid=s.id;sessionCache.set(s.id,s);dirty.set(s.id,s);if(permanent)this.windows.set(`${device}:${s.id}`,pts.slice(0,-1).map(({timestamp,voltage,current,power,protocol})=>({timestamp,voltage,current,power,protocol})));for(const old of pts.slice(0,-1)){const b=Math.floor(old.timestamp/60);if(!buckets.has(b))buckets.set(b,unpack(this.rows('SELECT data FROM history_minutes WHERE device=? AND minute=?',device,b)[0]?.data||'[]'));const existing=buckets.get(b).find(x=>x.timestamp===old.timestamp);if(existing){const op=existing.ports.find(x=>x.port===p.port);if(op){if(permanent)op.pid=s.id;else op.sid=s.id;};}}}}
 else if(s){const dt=ps.last===undefined?0:t-ps.last;if(dt>0&&dt<=30)s.total_wh+=((ps.integrationPower??ps.power)+p.voltage*p.current)*dt/7200;s.n++;s.sum_v+=p.voltage;s.sum_i+=p.current;}
 if(ps.placeholder){if(!p.enabled){ps.placeholder=false;gate.noteEnd(det.peak);}else if(!p.active||p.current<=0){ps.noLoadSince??=t;if(t-ps.noLoadSince>=15)ps.placeholder=false;}else ps.noLoadSince=null;}
 if(s){if(recording){if(permanent)p.pid=s.id;else p.sid=s.id;};s.permanent=permanent;s.peak_power_w=Math.max(s.peak_power_w,p.power);s.max_voltage=Math.max(s.max_voltage,p.voltage);s.min_power_w=Math.min(s.min_power_w,p.power);s.duration_sec=Math.max(0,Math.floor(t-s.start_time));s.avg_power_w=s.duration_sec?s.total_wh*3600/s.duration_sec:0;s.avg_voltage=s.sum_v/s.n;s.avg_current=s.sum_i/s.n;s.power_now=p.power;s.counts[p.protocol]=(s.counts[p.protocol]||0)+1;s.protocols=Object.keys(s.counts).sort((a,b)=>s.counts[b]-s.counts[a]).join(',');s.protocol=s.protocols.split(',')[0];s.is_active=true;if(permanent){let w=this.points(s,device);w.push({timestamp:t,voltage:p.voltage,current:p.current,power:p.power,protocol:p.protocol});this.windows.set(`${device}:${s.id}`,w.filter(x=>x.timestamp>=t-3600));}
 if(!p.active||p.current<=0){ps.noLoadSince??=t;}else ps.noLoadSince=null;
 if(!p.enabled||(ps.noLoadSince!==null&&ps.noLoadSince!==undefined&&t-ps.noLoadSince>=15)||(!permanent&&det.shouldEnd(t,s.total_wh,s.start_time))){s.end_time=t;s.is_active=false;s.end_reason=!p.enabled?'user_off':ps.noLoadSince!=null?(p.voltage<4?'unplug':'no_load'):'low_power';if(s.end_reason==='unplug')gate.noLoad();else gate.noteEnd(det.peak);Object.assign(det,new ChargeSessionDetector());ps.sid=null;this.windows.delete(`${device}:${s.id}`);dirty.set(s.id,s);ended.push(s);}else dirty.set(s.id,s);
 }
 if(!p.active||p.voltage<4||p.power===0)gate.noLoad();ps.last=t;ps.power=p.power;ps.integrationPower=p.voltage*p.current;ps.latest=point;}else{delete ps.last;delete ps.integrationPower;ps.pending=[];ps.noLoadSince=null;gate.above=null;det.samples=[];det.clear();det.lastEval=null;}
 ps.gate={...gate};ps.detector={...det};state[p.port]=ps;
 }
 const minute=Math.floor(t/60);if(!buckets.has(minute))buckets.set(minute,unpack(this.rows('SELECT data FROM history_minutes WHERE device=? AND minute=?',device,minute)[0]?.data||'[]'));buckets.get(minute).push(sample);state.last=t;accepted++;
 }
 if(!accepted)return {accepted:0};
 for(const s of dirty.values())if(!s.end_time)this.save(s,device);
 for(const [minute,data]of buckets)this.exec('INSERT INTO history_minutes(device,minute,data) VALUES(?,?,?) ON CONFLICT(device,minute) DO UPDATE SET data=excluded.data',device,minute,pack(data));for(const s of ended){if(s.total_wh<.05){this.exec('DELETE FROM history_sessions WHERE device=? AND id=?',device,s.id);continue;}this.finalize(s,device);this.learn(s,device);}this.setMeta('engine',state,device);this.exec('DELETE FROM history_minutes WHERE device=? AND minute<?',device,Math.floor((this.now()-this.retentionDays*86400)/60));return {accepted};
 }
 finalize(s,device){
  let count=0,seconds=0,sumVoltage=0,sumCurrent=0,weightedVoltage=0,weightedCurrent=0,maxVoltage=0,minPower=Infinity,previous=null;
  const protocols=Object.create(null);
  for(const point of this.iterateSessionPoints(s,device)){
   if(previous){
    const duration=point.timestamp-previous.timestamp;
    if(duration>0&&duration<=1800){
     seconds+=duration;
     weightedVoltage+=duration*(point.voltage+previous.voltage)/2;
     weightedCurrent+=duration*(point.current+previous.current)/2;
    }
   }
   count++;
   sumVoltage+=point.voltage;
   sumCurrent+=point.current;
   maxVoltage=Math.max(maxVoltage,point.voltage);
   if(point.power>.5)minPower=Math.min(minPower,point.power);
   const protocol=point.protocol.trim();
   if(protocol&&!['idle','5v'].includes(protocol.toLowerCase()))protocols[protocol]=(protocols[protocol]||0)+1;
   previous=point;
  }
  if(count){
   s.avg_voltage=round(seconds?weightedVoltage/seconds:sumVoltage/count);
   s.avg_current=round(seconds?weightedCurrent/seconds:sumCurrent/count);
   s.min_power_w=Number.isFinite(minPower)?round(minPower):0;
   s.max_voltage=round(maxVoltage);
   s.protocols=Object.keys(protocols).sort((a,b)=>protocols[b]-protocols[a]||a.localeCompare(b)).join(',');
  }
  s.total_wh=round(s.total_wh,4);s.avg_power_w=round(s.avg_power_w);s.peak_power_w=round(s.peak_power_w);
  this.save(s,device);
  if(s.device_name){
   const labels=this.meta('labels','shared',{}),sig=signature(s);
   if(labels[sig]?.name!==s.device_name){
    labels[sig]={name:s.device_name,cls:'',sample_session_id:s.id,updated_at:this.now()};
    this.setMeta('labels',labels,'shared');
   }
  }
 }
 setRecording(enabled,device='default'){const was=this.meta('recording',device,true);this.setMeta('recording',enabled,device);if(!enabled||was)return;const state=this.meta('engine',device,{}),t=this.now();for(let port=1;port<=4;port++){const ps=state[port];if(!ps?.placeholder||!ps.latest?.enabled||!ps.latest.active||ps.latest.current<=0)continue;const p=ps.latest,permanent=this.meta('permanent_ports',device,[]).includes(PORTS[port-1]);const s=this.save({port,start_time:t,end_time:null,total_wh:0,peak_power_w:0,avg_voltage:0,avg_current:0,duration_sec:0,protocol:p.protocol,protocols:p.protocol,permanent,device_name:'',n:0,sum_v:0,sum_i:0,max_voltage:0,min_power_w:0,counts:{},is_active:true},device);ps.sid=s.id;ps.placeholder=false;ps.last=t;ps.power=p.power;ps.integrationPower=p.voltage*p.current;ps.pending=[];}this.setMeta('engine',state,device);}
 pin(s,device='default'){const out=this.decorate(s);if(!s.end_time&&!s.device_name&&out.device.source==='labeled'&&out.device.name){s.device_name=out.device.name;this.save(s,device);out.device_name=s.device_name;}return out;}
 decorate(s){const sig=signature(s),labels=this.meta('labels','shared',{}),profile=this.meta('profiles','shared',{})[sig];let label=labels[sig],matched=null;const p=s.peak_power_w||0,v=s.max_voltage||s.avg_voltage||0,protos=(s.protocols||s.protocol||'').toUpperCase(),has=x=>protos.includes(x);let cls='unknown',brand='unknown',confidence=.2;if(p>=45&&v>=15){cls='laptop';confidence=.75;}else if(p>=30&&v>=15){cls=p<=35?'tablet':'laptop';brand=p<=35?'apple':'unknown';confidence=p<=35?.55:.5;}else if(has('SCP')){cls='phone';brand='huawei';confidence=.7;}else if(has('UFCS')){cls='phone';brand='generic_cn';confidence=.55;}else if(v>=15&&p>=20){cls='laptop';confidence=.5;}else if(v>=15&&p>=12){cls='tablet';confidence=.45;}else if(has('PPS')&&p>=15&&p<=45){cls='phone';brand='samsung';confidence=.45;}else if(p>=18&&v>=8&&v<=12){cls='phone';brand='apple';confidence=.4;}else if(p<7){cls='small';confidence=.65;}else if(p<18&&v<=5.6){cls='powerbank';confidence=.45;}else if(p>=7){cls='phone';confidence=.35;}
 if(!label&&p>=8){const [proto,pow,volt]=sig.split('|');let best=Infinity;for(const [key,l]of Object.entries(labels)){const [lp,lw,lv]=key.split('|'),dist=Math.abs(Number(lw)-Number(pow));if(l.name&&proto===lp&&volt===lv&&dist<=5){if(dist<best){best=dist;label=l;matched=key;}else if(dist===best){label=null;matched=null;}}}}
 const names={laptop:'笔记本',tablet:'平板',phone:'手机',small:'耳机/手表',powerbank:'充电宝/配件',unknown:'未知设备'},brands={huawei:'华为/荣耀系',apple:'苹果系',samsung:'三星/Pixel 系',generic_cn:'国产快充机型',unknown:''};const named=s.device_name||label?.name;cls=label?.cls||cls;return {...s,device:{signature:sig,name:named||'',cls,cls_label:names[cls]||cls,brand,brand_label:brands[brand],confidence:s.device_name?1:label?(matched?.7:1):confidence,source:named?'labeled':'guessed',hint:cls==='laptop'&&s.avg_voltage>=19?'20V 恒压档，典型笔记本供电':cls==='small'?'小电流慢充，多为耳机/手表/键鼠':'',...(label?{exact:!matched,...(matched?{matched_signature:matched}:{})}:{})},...(s.cap_wh?{}:profile?.cap_wh?{cap_wh:profile.cap_wh,cap_from_profile:true}:{})};}

 learn(s,device){
  if(!s.end_time||s.start_pct==null||s.start_pct<5||s.start_pct>=100||!(s.cap_wh>0))return false;
  const prof=this.meta('profiles','shared',{})[signature(s)],key=(prof?.model?(prof.brand&&!prof.model.includes(prof.brand)?prof.brand+' '+prof.model:prof.model):'')||s.device_name;
  if(!key)return false;
  const acc={},bands=[0,50,70,75,80,90,95,100];
  let count=0,cum=0,measuredPeak=0,previous=null;
  for(const point of this.iterateSessionPoints(s,device)){
   const before=previous;
   previous=point;
   count++;
   measuredPeak=Math.max(measuredPeak,point.power);
   if(!before)continue;
   const dt=point.timestamp-before.timestamp;
   if(dt<=0||dt>120)continue;
   const e=(point.power+before.power)*dt/7200;
   if(e<=0)continue;
   const mid=s.start_pct+(cum+e/2-(s.pct_wh||0))*.88/s.cap_wh*100;
   cum+=e;
   const lo=bands.find((b,j)=>j<bands.length-1&&mid>=b&&mid<bands[j+1]);
   if(lo!==undefined){acc[lo]??=[0,0];acc[lo][0]+=e;acc[lo][1]+=dt;}
  }
  const peak=s.peak_power_w>=3?s.peak_power_w:measuredPeak;
  if(count<3||peak<3)return false;
 const curves=this.meta('curves','shared',{}),old=curves[key]||{curve:[],n:0},map=Object.fromEntries(old.curve);let learned=false;for(const [lo,[wh,sec]]of Object.entries(acc))if(sec>=60){const ratio=Math.min(1.2,Math.max(.03,wh/sec*3600/peak));map[lo]=round(map[lo]===undefined?ratio:(map[lo]*old.n+ratio)/(old.n+1),3);learned=true;}if(!learned)return false;curves[key]={curve:Object.entries(map).map(([a,b])=>[Number(a),b]).sort((a,b)=>a[0]-b[0]),n:old.n+1,peak_w:round(peak,1),updated_at:this.now()};this.setMeta('curves',Object.fromEntries(Object.entries(curves).sort((a,b)=>b[1].updated_at-a[1].updated_at).slice(0,50)),'shared');return true;
 }
 handle(request,device='default'){return handleHistoryRequest(this,request,device);}
}
