import { historyMethods } from './protocol.js';
export { TelemetryRoom } from './room.js';
export { LoginLimiter } from './login-limiter.js';
const room=env=>env.ROOM.get(env.ROOM.idFromName('charger'));
const COOKIE='cuktech_session', TTL=12*3600*1000;
const enc=new TextEncoder();
const b64=bytes=>btoa(String.fromCharCode(...new Uint8Array(bytes))).replaceAll('+','-').replaceAll('/','_').replaceAll('=','');
async function signature(secret,value){const key=await crypto.subtle.importKey('raw',enc.encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']);return b64(await crypto.subtle.sign('HMAC',key,enc.encode(value)));}
function equal(a,b){if(typeof a!=='string'||typeof b!=='string')return false;let diff=a.length^b.length;for(let i=0;i<Math.max(a.length,b.length);i++)diff|=(a.charCodeAt(i)||0)^(b.charCodeAt(i)||0);return diff===0;}
export async function signSession(secret,now=Date.now()){const payload=`${now+TTL}.${crypto.randomUUID()}`;return `${payload}.${await signature(secret,payload)}`;}
export async function verifySession(token,secret,now=Date.now()){if(!secret||typeof token!=='string'||token.length>256)return false;const parts=token.split('.');if(parts.length!==3||!/^\d+$/.test(parts[0]))return false;const expiry=Number(parts[0]);return expiry>now && expiry<=now+TTL && equal(parts[2],await signature(secret,parts.slice(0,2).join('.')));}
const json=(data,status=200,headers={})=>Response.json(data,{status,headers:{'Cache-Control':'no-store',...headers}});
const cookie=(value,maxAge)=>`${COOKIE}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Strict`;
function sessionToken(req){return req.headers.get('Cookie')?.split(';').map(x=>x.trim()).find(x=>x.startsWith(COOKIE+'='))?.slice(COOKIE.length+1);}
export default {
 async fetch(request,env){
  const url=new URL(request.url),path=url.pathname;
  if(!path.startsWith('/api/')){
   let staticPath;try{staticPath=decodeURIComponent(path).replace(/\/+$/,'')||'/';}catch{return new Response('Invalid path',{status:400});}
   const login=['/login','/login.html'].includes(staticPath), consolePage=staticPath==='/'||staticPath.endsWith('.html')||!staticPath.split('/').at(-1).includes('.');
   if(consolePage&&!login&&!await authorizedSession(request,env))return new Response(null,{status:302,headers:{Location:'/login.html','Cache-Control':'no-store'}});
   return env.ASSETS.fetch(request);
  }
  const sameOrigin=request.headers.get('Origin')===url.origin;
  if(path==='/api/login'){
   if(request.method!=='POST')return json({error:'Method not allowed'},405);
   if(!sameOrigin)return json({error:'Forbidden origin'},403);
   if(!env.VIEWER_PASSWORD||!env.SESSION_SECRET)return json({error:'Service not configured'},503);
   if(Number(request.headers.get('Content-Length'))>1024)return json({error:'Body too large'},413);
   let body;try{const raw=await request.text();if(enc.encode(raw).length>1024)return json({error:'Body too large'},413);body=JSON.parse(raw);}catch{return json({error:'Invalid JSON'},400);}
   const success=equal(body?.password,env.VIEWER_PASSWORD);
   const ipHash=await signature(env.SESSION_SECRET,'login-ip:'+ (request.headers.get('CF-Connecting-IP')||'unknown'));
   const limit=await env.LOGIN_LIMITER.get(env.LOGIN_LIMITER.idFromName(ipHash)).fetch(new Request('https://limit/check',{method:'POST',body:JSON.stringify({success})}));
   const result=await limit.json();
   if(!result.allowed)return json({error:'Too many attempts'},429,{'Retry-After':String(result.retryAfter)});
   if(!success)return json({error:'Unauthorized'},401);
   return json({authenticated:true},200,{'Set-Cookie':cookie(await signSession(env.SESSION_SECRET),TTL/1000)});
  }
  if(path==='/api/logout'){
   if(request.method!=='POST')return json({error:'Method not allowed'},405);
   if(!sameOrigin)return json({error:'Forbidden origin'},403);
   const token=sessionToken(request);
   if(await verifySession(token,env.SESSION_SECRET))await room(env).fetch(new Request('https://room/logout',{method:'POST',headers:{'X-Session-Id':await signature(env.SESSION_SECRET,token),'X-Session-Expires':token.split('.')[0]}}));
   return json({authenticated:false},200,{'Set-Cookie':cookie('',0)});
  }
  if(path==='/api/session'){
   if(request.method!=='GET')return json({error:'Method not allowed'},405);
   return await authorizedSession(request,env)?json({authenticated:true}):json({authenticated:false},401);
  }
  const management=path.match(/^\/api\/devices\/(register|(default|[0-9a-f-]{36})\/(rename|rotate-token|revoke))$/);
  if(management){
   if(request.method!=='POST')return json({error:'Method not allowed'},405);
   if(!sameOrigin)return json({error:'Forbidden origin'},403);
   if(!await authorizedSession(request,env))return json({error:'Unauthorized'},401);
   const body=await request.text();if(enc.encode(body).length>1024)return json({error:'Body too large'},413);
   const route=management[1]==='register'?'register':management[2]+'/'+management[3];
   const response=await room(env).fetch(new Request('https://room/registry/'+route,{method:'POST',body}));
   const result=await response.json();if(result.token){result.provisioning={cloud_url:`wss://${url.host}/api/device`,cloud_token:result.token};delete result.token;}
   return json(result,response.status);
  }
  let routePath=path, pathDevice=null;
  const match=path.match(/^\/api\/device\/([^/]+)\/(.+)$/);if(match){pathDevice=match[1];routePath='/api/'+match[2];}
  const devices=url.searchParams.getAll('device');
  if(devices.length>1||(pathDevice&&devices.length&&pathDevice!==devices[0]))return json({ok:false,error:'Invalid device'},400);
  const device=pathDevice??devices[0]??'default';
  if(!/^(default|[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/.test(device))return json({ok:false,error:'Invalid device'},400);
  const methods=historyMethods(routePath);
  if(methods){
   if(!methods.includes(request.method))return json({ok:false,error:'Method not allowed'},405);
   if(request.method!=='GET'&&!sameOrigin)return json({ok:false,error:'Forbidden origin'},403);
   if(!await authorizedSession(request,env))return json({ok:false,error:'Unauthorized'},401);
   let body;if(request.method!=='GET'){if(Number(request.headers.get('Content-Length'))>16384)return json({ok:false,error:'Body too large'},413);body=await request.text();if(enc.encode(body).length>16384)return json({ok:false,error:'Body too large'},413);}
   return room(env).fetch(new Request('https://room'+routePath+url.search,{method:request.method,headers:{'X-Device-Id':device},...(body?{body}:{})}));
  }
  if(['/api/status','/api/devices','/api/port','/api/set','/api/protocol','/api/enable'].includes(routePath)){
   const control=!['/api/status','/api/devices'].includes(routePath);
   if(request.method!==(control?'POST':'GET'))return json({ok:false,error:'Method not allowed'},405);
   if(control&&!sameOrigin)return json({ok:false,error:'Forbidden origin'},403);
   if(!await authorizedSession(request,env))return json({ok:false,error:'Unauthorized'},401);
   let body;if(control){if(Number(request.headers.get('Content-Length'))>2048)return json({ok:false,error:'Body too large'},413);body=await request.text();if(enc.encode(body).length>2048)return json({ok:false,error:'Body too large'},413);}
   const route=control?'/control/'+routePath.split('/').at(-1):routePath.slice(4);
   return room(env).fetch(new Request('https://room'+route+(route==='/devices'&&url.searchParams.get('include_archived')==='1'?'?include_archived=1':''),{method:control?'POST':'GET',headers:{'X-Device-Id':device},...(control?{body}:{} )}));
  }
  if(!['/api/device','/api/live'].includes(path))return json({error:'Not found'},404);
  if(request.method!=='GET')return json({error:'Method not allowed'},405);
  const role=path==='/api/device'?'device':'viewer';
  if(role==='viewer'&&!sameOrigin)return json({error:'Forbidden origin'},403);
  if(role==='device'){
   const auth=request.headers.get('Authorization')||'', token=auth.startsWith('Bearer ')?auth.slice(7):'';
   if(!token||token.length>256)return json({error:'Unauthorized'},401);
   const digest=new Uint8Array(await crypto.subtle.digest('SHA-256',enc.encode(token))),hash=[...digest].map(x=>x.toString(16).padStart(2,'0')).join('');
   const legacy=!!env.DEVICE_TOKEN&&equal(token,env.DEVICE_TOKEN);
   const verified=await room(env).fetch(new Request('https://room/registry/authorize',{headers:{'X-Token-Hash':hash,'X-Legacy':legacy?'1':'0'}}));
   if(!verified.ok)return json({error:'Unauthorized'},401);var identity=await verified.json();
  }else if(!await authorizedSession(request,env))return json({error:'Unauthorized'},401);
  if(request.headers.get('Upgrade')?.toLowerCase()!=='websocket')return json({error:'WebSocket required'},426);
  const headers=new Headers();headers.set('Upgrade','websocket');headers.set('X-Room-Role',role);if(role==='device'){headers.set('X-Device-Id',identity.id);headers.set('X-Credential-Version',String(identity.version));}
  if(role==='viewer'){const token=sessionToken(request);headers.set('X-Session-Id',await signature(env.SESSION_SECRET,token));headers.set('X-Session-Expires',token.split('.')[0]);}
  // Rebuild the internal request so untrusted clients cannot set their own role.
  return room(env).fetch(new Request('https://room/connect',{headers}));
 }
};

async function authorizedSession(request,env){const token=sessionToken(request);if(!await verifySession(token,env.SESSION_SECRET))return false;const response=await room(env).fetch(new Request('https://room/session',{headers:{'X-Session-Id':await signature(env.SESSION_SECRET,token)}}));return response.status===200;}
