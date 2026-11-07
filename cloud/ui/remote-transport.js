/* Keep the existing dashboard's EventSource contract over authenticated WSS. */
(() => {
  const NativeEventSource = window.EventSource;
  class CloudEvents extends EventTarget {
    static CONNECTING=0; static OPEN=1; static CLOSED=2;
    constructor(url) {
      super(); this.url=String(url); this.readyState=0; this.closed=false; this.delay=1000;
      this.connect();
    }
    fire(type,event) { this.dispatchEvent(event); this['on'+type]?.(event); }
    watchdog(now=Date.now()) {
      const seen=this.lastDataByDevice || (this.lastDataAt?{default:this.lastDataAt}:{});
      this.staleDevices??=new Set();
      for(const [device,last] of Object.entries(seen)) {
        if(this.staleDevices.has(device)||!last||now-last<=15000)continue;
        this.staleDevices.add(device);this.stale=true;if(CloudEvents.lastStatus)delete CloudEvents.lastStatus[device];
        this.fire('message',new MessageEvent('message',{data:JSON.stringify({type:'status',device,connected:false,authenticated:false,mqtt_connected:false,connection:{phase:'disabled',attempt_id:0,last_error:null,retry_at:null}})}));
        if(!window.DeviceStore || window.DeviceStore.current()===device)CloudEvents.freshness('stale');
      }
    }
    static gatewayOffline(device) {
      if(CloudEvents.lastStatus)delete CloudEvents.lastStatus[device];
      if(!window.DeviceStore || window.DeviceStore.current()===device)CloudEvents.freshness('offline');
    }
    static freshness(state,receivedAt) {
      const el=document.getElementById?.('cloudFreshness');if(!el)return;
      const en=(window.I18N?.getLocale?.()||'').startsWith('en');
      const label=state==='stale'?(en?'Data is stale':'数据已过期'):state==='offline'?(en?'Gateway offline':'网关离线'):state==='ble-off'?(en?'Gateway online · BLE disconnected':'网关在线 · 蓝牙未连接'):(en?'Live':'实时数据');
      el.textContent=receivedAt?`${label} · ${new Date(receivedAt).toLocaleTimeString()}`:label;
    }
    connect() {
      if(this.closed)return;
      const url=new URL('/api/live',location.href);url.protocol=location.protocol==='https:'?'wss:':'ws:';
      const socket=this.socket=new WebSocket(url);
      socket.onopen=()=>{if(socket!==this.socket)return;this.readyState=1;this.delay=1000;this.lastDataAt=Date.now();this.lastDataByDevice={};this.staleDevices=new Set();this.stale=false;this.fire('open',new Event('open'));this.staleTimer=setInterval(()=>this.watchdog(),5000);
        this.heartbeat=setInterval(()=>{if(socket.readyState===WebSocket.OPEN)socket.send('{"type":"ping"}');},30000);};
      socket.onmessage=e=>{if(socket!==this.socket)return;let msg;try{msg=JSON.parse(e.data);}catch{return;}
        if(msg.type==='pong')return;
        if(msg.type==='telemetry'){const device=msg.device||'default';this.lastDataAt=Date.now();this.lastDataByDevice[device]=this.lastDataAt;this.staleDevices.delete(device);this.stale=false;if(!window.DeviceStore||window.DeviceStore.current()===device)CloudEvents.freshness(msg.bleConnected?'live':'ble-off',msg.receivedAt);}
        if(msg.type==='status' && msg.deviceConnected===false)CloudEvents.gatewayOffline(msg.device||'default');
        for(const event of CloudEvents.adapt(msg))this.fire('message',new MessageEvent('message',{data:JSON.stringify(event)}));
      };
      socket.onclose=()=>{if(socket!==this.socket)return;clearInterval(this.heartbeat);clearInterval(this.staleTimer);CloudEvents.lastStatus={};CloudEvents.freshness('offline');if(this.closed)return;this.readyState=0;this.fire('error',new Event('error'));
        this.retry=setTimeout(async()=>{try{const r=await fetch('/api/session',{cache:'no-store'});if(r.status===401){this.close();location.assign('/login.html');return;}}catch{}
          this.connect();},this.delay);this.delay=Math.min(this.delay*2,30000);};
      socket.onerror=()=>{}; // close handler owns recovery and visible status.
    }
    static adapt(msg) {
      if((msg.type==='init'||msg.type==='mac-status') && msg.data){
        const data=msg.data, device=msg.device||'default';
        CloudEvents.latestPorts??={};CloudEvents.lastStatus??={};CloudEvents.latestPorts[device]=data.ports;
        const fingerprint=JSON.stringify([data.connected,data.authenticated,data.settings,data.protocol_extend,data.firmware_version,data.device_model,data.gateway_connected,Object.values(data.ports||{}).map(p=>[p.valid,p.enabledKnown])]);
        const changed=fingerprint!==CloudEvents.lastStatus[device];CloudEvents.lastStatus[device]=fingerprint;
        if(msg.type==='init')return [{...data,type:'init',device,...(msg.devices?{devices:msg.devices}:{})}];
        return changed?[{...data,type:'status',device}]:[];
      }
      if(msg.type==='telemetry') {
        if(!msg.bleConnected)return [];
        const ids={c1:1,c2:2,c3:3,a:4};
        const device=msg.device||'default';
        return msg.ports.filter(p=>p.valid).map(p=>({type:'port_update',device,port_id:ids[p.id],data:{...p,enabled:CloudEvents.latestPorts?.[device]?.[ids[p.id]]?.enabled ?? false,enabledKnown:CloudEvents.latestPorts?.[device]?.[ids[p.id]]?.enabledKnown}}));
      }
      if(msg.type==='status' && 'deviceConnected' in msg && !('connected' in msg))return msg.deviceConnected?[]:[{type:'status',device:msg.device||'default',connected:false,authenticated:false,mqtt_connected:false,connection:{phase:'disabled',attempt_id:0,last_error:null,retry_at:null}}];
      return [msg];
    }
    close(){this.closed=true;this.readyState=2;clearTimeout(this.retry);clearInterval(this.heartbeat);clearInterval(this.staleTimer);const s=this.socket;this.socket=null;s?.close();}
  }
  window.EventSource=class extends CloudEvents {
    constructor(url,options){if(new URL(url,location.href).pathname!=='/api/events')return new NativeEventSource(url,options);super(url);}
  };
  document.addEventListener('DOMContentLoaded',()=>{
    const freshness=document.createElement('span');freshness.id='cloudFreshness';freshness.setAttribute('role','status');freshness.style.cssText='font-size:11px;opacity:.7;margin-inline:8px';document.querySelector('.topbar-status')?.append(freshness);CloudEvents.freshness('offline');
    const button=document.createElement('button');button.textContent='退出远程访问';button.type='button';
    button.style.cssText='position:fixed;bottom:10px;right:12px;z-index:10000;border:1px solid #8885;border-radius:20px;padding:8px 14px;background:var(--card-bg,#fff);color:var(--text,#222);font-size:12px;cursor:pointer';
    button.addEventListener('click',async()=>{button.disabled=true;try{const r=await fetch('/api/logout',{method:'POST'});if(!r.ok)throw Error();location.replace('/login.html');}catch{button.textContent='退出失败，点此重试';button.disabled=false;}});
    document.body.append(button);
  });
})();
