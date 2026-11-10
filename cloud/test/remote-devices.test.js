import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
test('sync injects management UI on both dashboards and configuration page',async()=>{const script=await readFile(new URL('../scripts/sync-web.mjs',import.meta.url),'utf8');assert.match(script,/\['index\.html','phone\.html','config\.html'\]/);assert.match(script,/remote-devices\.js/);assert.match(script,/remote-devices\.css/);});

test('the generated configuration page has a return link and a management section before scripts run', async () => {
 const config=await readFile(new URL('../public/config.html',import.meta.url),'utf8');
 assert.match(config, /<main [^>]*data-remote-config/);
 assert.match(config, /<a [^>]*href="\/"[^>]*>返回仪表盘<\/a>/);
 assert.match(config, /<h1>远程设备配置<\/h1>/);
 assert.match(config, /data-remote-actions/);
});
