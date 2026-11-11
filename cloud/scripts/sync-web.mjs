import { cp, readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root=fileURLToPath(new URL('../../',import.meta.url));
const destination=path.join(root,'cloud/public');
await mkdir(destination,{recursive:true});
await cp(path.join(root,'src/cuktech-ble-ha-main/ble_server/web'),destination,{recursive:true});
for(const name of await readdir(path.join(root,'cloud/ui')))await cp(path.join(root,'cloud/ui',name),path.join(destination,name));
for(const name of ['index.html','phone.html','config.html']){
 const p=path.join(destination,name);let s=await readFile(p,'utf8');
 s=s.replace('<span>macOS</span>', '<span>ESP32</span>');
 const freshness='<span class="cloud-freshness"><span id="cloudFreshness" role="status">正在连接网关…</span><span id="cloudFreshnessTime"></span></span>';
 if(name==='index.html')s=s.replace('<div class="topbar-status">',`<div class="topbar-status">\n${freshness}`);
 if(name==='phone.html')s=s.replace('href="config.html"','href="/config.html?from=phone"').replace('<div id="connectionFeedback"',`${freshness}\n<div id="connectionFeedback"`);
 const transport=name==='config.html'?'':'<script src="/remote-transport.js"></script>\n';
 s=s.replace('</head>',`<link rel="stylesheet" href="/remote-devices.css">\n${transport}<script defer src="/remote-devices.js"></script>\n</head>`);
 await writeFile(p,s);
}
console.log('Synced complete existing web UI and cloud transport.');
