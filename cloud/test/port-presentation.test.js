import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import vm from 'node:vm';
const window={I18N:{getLocale:()=> 'zh-CN'}};vm.runInNewContext(readFileSync(new URL('../../src/cuktech-ble-ha-main/ble_server/web/static/port-ui.js',import.meta.url),'utf8'),{window});
test('port labels distinguish unavailable, off, idle and active without stale protocol',()=>{
 const p=window.PortUI;
 assert.equal(p.status({valid:false,power:30}), '暂无数据');
 assert.equal(p.status({valid:true,enabledKnown:true,enabled:false,power:0}), '端口已关闭');
 assert.equal(p.status({valid:true,enabled:true,power:0,protocol:'PPS'}), '空闲');
 assert.equal(p.protocol({valid:true,power:0,protocol:'PPS'}), '');
 assert.equal(p.status({valid:true,enabled:true,power:12,protocol:'PD'}), '正在供电');
 assert.equal(p.protocol({valid:true,power:12,protocol:'PD'}), 'PD');
});
test('automation surfaces restart, unavailable and pending states',()=>{const p=window.PortUI;assert.match(p.automation({error:'limit_restart_unavailable'},true,true),/暂停/);assert.match(p.automation({},false,true),/网关/);assert.match(p.automation({pending:true},true,true),/正在/);assert.equal(p.automation({},true,false),'');});
