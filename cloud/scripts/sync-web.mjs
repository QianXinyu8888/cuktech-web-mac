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
 if(name==='config.html')s='<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>远程设备配置</title></head><body></body></html>';
 s=s.replace('<span>macOS</span>', '<span>ESP32</span>');
 s=s.replace('</head>','<link rel="stylesheet" href="/remote-devices.css">\n<script src="/remote-transport.js"></script>\n<script defer src="/remote-devices.js"></script>\n</head>');
 await writeFile(p,s);
}
console.log('Synced complete existing web UI and cloud transport.');
