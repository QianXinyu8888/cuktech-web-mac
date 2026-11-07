const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../../web/static/setup-entry.js'), 'utf8');
for (const [search, expected] of [['', []], ['?setup=other', []], ['?setup=esp32', ['modal', 'qr']]]) {
  const calls = [];
  vm.runInNewContext(source, {URLSearchParams, location: {search},
    openXiaomiModal() { calls.push('modal'); }, xiaomiStartQR() { calls.push('qr'); }});
  assert.deepEqual(calls, expected);
}
console.log('Setup QR entry tests passed');
