import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
test('sync injects management UI on both dashboards and configuration page',async()=>{const script=await readFile(new URL('../scripts/sync-web.mjs',import.meta.url),'utf8');assert.match(script,/\['index\.html','phone\.html','config\.html'\]/);assert.match(script,/remote-devices\.js/);assert.match(script,/remote-devices\.css/);});
