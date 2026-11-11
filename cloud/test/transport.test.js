import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const source=readFileSync(new URL('../ui/remote-transport.js',import.meta.url),'utf8');
function transport(overrides={}){const ctx={window:{EventSource:class{}},document:{addEventListener(){}},location:{href:'https://example.com/',protocol:'https:'},EventTarget,Event,MessageEvent,URL,console,...overrides};vm.runInNewContext(source,ctx);return ctx.window.EventSource;}
test('status preserves charger settings while real samples update charts',()=>{
 const T=transport();const initial=T.adapt({type:'mac-status',data:{connected:true,settings:{'16':7},ports:{1:{enabled:false}}}});
 assert.equal(initial[0].settings['16'],7);
 const updates=T.adapt({type:'telemetry',bleConnected:true,ports:[{id:'c1',valid:true,power:12.3},{id:'c2',valid:false,power:0}]});
 assert.equal(updates.length,1);assert.equal(updates[0].type,'port_update');assert.equal(updates[0].port_id,1);assert.equal(updates[0].data.enabled,false);assert.equal(updates[0].data.power,12.3);
});
test('gateway disconnect generates offline status; unknown readings are not emitted',()=>{
 const T=transport();const status=T.adapt({type:'status',deviceConnected:false})[0];
 assert.equal(status.connected,false);
 assert.equal(status.ports[1].valid,false);
 assert.equal(status.ports[1].enabledKnown,false);
 assert.equal(T.adapt({type:'telemetry',bleConnected:false,ports:[]}).length,0);
});
test('unchanged status does not rebuild dashboard every telemetry tick',()=>{const T=transport();const s={connected:true,authenticated:true,settings:{'16':15},ports:{1:{enabled:true,power:1}},receivedAt:100};assert.equal(T.adapt({type:'init',data:s})[0].type,'init');assert.equal(T.adapt({type:'mac-status',data:{...s,ports:{1:{enabled:true,power:5}},receivedAt:101}}).length,0);const changed=T.adapt({type:'mac-status',data:{...s,connected:false}});assert.equal(changed[0].type,'status');});
test('gateway disconnect clears stale connection diagnostics',()=>{const T=transport();const events=T.adapt({type:'status',deviceConnected:false});assert.equal(events[0].connection.phase,'disabled');});
test('connection phase changes are forwarded even when charger remains disconnected',()=>{const T=transport(),base={connected:false,authenticated:false,settings:{},ports:{},gateway_connected:true};T.adapt({type:'init',device:'phase-test',data:{...base,connection:{phase:'waiting'}}});const events=T.adapt({type:'mac-status',device:'phase-test',data:{...base,connection:{phase:'scanning'}}});assert.equal(events.length,1);assert.equal(events[0].connection.phase,'scanning');});
test('silent but open gateway is marked stale once and can recover',()=>{const T=transport(), instance=Object.create(T.prototype),events=[];instance.lastDataByDevice={default:1000};instance.freshnessByDevice=new Map();instance.renderFreshness=()=>{};instance.fire=(type,e)=>events.push(JSON.parse(e.data));instance.watchdog(15999);assert.equal(events.length,0);instance.watchdog(16001);assert.equal(events[0].connected,false);assert.equal(events[0].connection.phase,'disabled');instance.watchdog(20000);assert.equal(events.length,1);});
test('simultaneous chargers preserve device identity and per-device port switches',()=>{const T=transport();const a={connected:true,authenticated:true,settings:{'16':0},ports:{1:{enabled:false}}},b={...a,settings:{'16':15},ports:{1:{enabled:true}}};const first=T.adapt({type:'init',device:'a1',devices:[{id:'a1'},{id:'b1'}],data:a});assert.equal(first[0].device,'a1');assert.equal(first[0].devices.length,2);T.adapt({type:'init',device:'b1',devices:[{id:'a1'},{id:'b1'}],data:b});const msg={type:'telemetry',bleConnected:true,ports:[{id:'c1',valid:true,power:3}]};assert.equal(T.adapt({...msg,device:'a1'})[0].data.enabled,false);assert.equal(T.adapt({...msg,device:'b1'})[0].data.enabled,true);assert.equal(T.adapt({...msg,device:'a1'})[0].device,'a1');});
test('one silent charger is marked stale while a second remains active',()=>{const T=transport(),instance=Object.create(T.prototype),events=[];instance.lastDataByDevice={a1:1000,b1:14500};instance.staleDevices=new Set();instance.freshnessByDevice=new Map();instance.renderFreshness=()=>{};instance.fire=(type,e)=>events.push(JSON.parse(e.data));instance.watchdog(17000);assert.equal(events.length,1);assert.equal(events[0].device,'a1');assert.equal(events[0].connected,false);});
test('offline event only resets that gateway status fingerprint',()=>{const T=transport();const data={connected:true,ports:{},settings:{}};T.adapt({type:'init',device:'one',data});T.adapt({type:'init',device:'two',data});T.gatewayOffline('two');assert.equal(T.adapt({type:'mac-status',device:'one',data}).length,0);assert.equal(T.adapt({type:'mac-status',device:'two',data}).length,1);});

test('freshness follows the selected gateway even if it has no telemetry', () => {
 const window=new EventTarget();
 let selected='first', socket;
 const badge={textContent:''};
 window.DeviceStore={current:()=>selected};
 const T=transport({window,document:{getElementById:id=>id==='cloudFreshness'?badge:null},WebSocket:class{constructor(){socket=this;}},setInterval(){}});
 const events=new T('/api/events');
 socket.onopen();
 const send=msg=>socket.onmessage({data:JSON.stringify(msg)});
 send({type:'status',device:'first',deviceConnected:true});
 send({type:'telemetry',device:'first',bleConnected:true,ports:[]});
 assert.equal(badge.textContent,'网关在线 · 蓝牙未连接');
 send({type:'init',device:'first',data:{connected:true,gateway_connected:true,ports:{}}});
 send({type:'telemetry',device:'first',bleConnected:true,ports:[]});
 send({type:'init',device:'second',data:{connected:false,gateway_connected:true,ports:{}}});
 assert.equal(badge.textContent,'实时数据');
 selected='second';
 window.dispatchEvent(new Event('device-changed'));
 assert.equal(badge.textContent,'网关在线 · 蓝牙未连接');
 send({type:'status',device:'second',deviceConnected:false});
 events.watchdog(Date.now()+20000);
 assert.equal(badge.textContent,'网关离线');
});
