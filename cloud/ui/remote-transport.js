/* Keep the existing dashboard's EventSource contract over authenticated WSS. */
(() => {
  const NativeEventSource = window.EventSource;
  class CloudEvents extends EventTarget {
    static CONNECTING=0; static OPEN=1; static CLOSED=2;
    constructor(url) {
      super(); this.url=String(url); this.readyState=0; this.closed=false; this.delay=1000;
      this.freshnessByDevice=new Map();
      this.lastDataByDevice={};
      this.staleDevices=new Set();
      this.renderFreshness=()=>{
        const device=window.DeviceStore?.current()||'default';
        const current=this.freshnessByDevice.get(device);
        CloudEvents.freshness(current?.state??(this.readyState===1?'connecting':'offline'),current?.receivedAt);
      };
      window.addEventListener('device-changed',this.renderFreshness);
      this.connect();
    }
    fire(type,event) { this.dispatchEvent(event); this['on'+type]?.(event); }
    watchdog(now=Date.now()) {
      const seen=this.lastDataByDevice;
      this.staleDevices??=new Set();
      for(const [device,last] of Object.entries(seen)) {
        if(this.staleDevices.has(device)||!last||now-last<=15000)continue;
        this.staleDevices.add(device);CloudEvents.gatewayOffline(device);
        this.freshnessByDevice.set(device,{...this.freshnessByDevice.get(device),state:'stale'});
        this.fire('message',new MessageEvent('message',{data:JSON.stringify(CloudEvents.offlineStatus(device))}));
      }
      this.renderFreshness();
    }
    static gatewayOffline(device) {
      if(CloudEvents.lastStatus)delete CloudEvents.lastStatus[device];
    }
    static offlineStatus(device) {
      const ports=Object.fromEntries([1,2,3,4].map(id=>[id,{voltage:0,current:0,power:0,active:false,valid:false,enabled:false,enabledKnown:false,protocol:'idle'}]));
      return {type:'status',device,ports,connected:false,authenticated:false,mqtt_connected:false,connection:{phase:'disabled',attempt_id:0,last_error:null,retry_at:null}};
    }
    static freshness(state,receivedAt) {
      const el=document.getElementById?.('cloudFreshness');if(!el)return;
      const en=(window.I18N?.getLocale?.()||'').startsWith('en');
      const labels={stale:['数据已过期 · 检查网络','Data is stale · check network'],offline:['网关离线 · 检查 ESP32 供电和 Wi-Fi','Gateway offline · check power and Wi-Fi'],'ble-off':['网关在线 · 蓝牙未连接','Gateway online · BLE disconnected'],live:['网页 · 云端 · 网关 · 蓝牙已连接','Web · cloud · gateway · BLE connected'],connecting:['网页正在连接云端…','Connecting to cloud…']};
      const label=labels[state][en?1:0];
      if(el.textContent!==label)el.textContent=label;
      const time=document.getElementById('cloudFreshnessTime');
      if(time) {
        const seconds=receivedAt?Math.max(0,Math.floor((Date.now()-receivedAt)/1000)):null;
        time.textContent=seconds===null?'':en?` · Updated ${seconds}s ago`:` · 最后更新 ${seconds} 秒前`;
        time.title=receivedAt?new Date(receivedAt).toLocaleTimeString():'';
      }
    }
    updateFreshness(msg) {
      const device=msg.device||'default';
      const current=this.freshnessByDevice.get(device);
      if(msg.type==='status' && typeof msg.deviceConnected==='boolean'){
        if(!msg.deviceConnected){
          CloudEvents.gatewayOffline(device);
          delete this.lastDataByDevice[device];
          this.freshnessByDevice.set(device,{state:'offline'});
        }else{
          this.lastDataByDevice[device]=Date.now();
          this.freshnessByDevice.set(device,{state:'ble-off'});
        }
        this.staleDevices.delete(device);
      }else if((msg.type==='init'||msg.type==='mac-status') && msg.data){
        const {gateway_connected:online,connected,receivedAt}=msg.data;
        if(!online){
          delete this.lastDataByDevice[device];
          this.freshnessByDevice.set(device,{state:'offline'});
        }else if(current?.state!=='stale'||receivedAt!==current.receivedAt){
          this.lastDataByDevice[device]??=Date.now();
          this.freshnessByDevice.set(device,{state:connected?'live':'ble-off',receivedAt,hasSnapshot:true});
        }
      }else if(msg.type==='telemetry'){
        // The room can replay a cached sample before init. The authoritative
        // snapshot already includes it and says whether it is still fresh.
        if(!current?.hasSnapshot||current.state==='offline')return false;
        this.lastDataByDevice[device]=Date.now();
        this.staleDevices.delete(device);
        this.freshnessByDevice.set(device,{state:msg.bleConnected?'live':'ble-off',receivedAt:msg.receivedAt,hasSnapshot:true});
      }
      return true;
    }
    connect() {
      if(this.closed)return;
      const url=new URL('/api/live',location.href);url.protocol=location.protocol==='https:'?'wss:':'ws:';
      const socket=this.socket=new WebSocket(url);
      socket.onopen=()=>{if(socket!==this.socket)return;this.readyState=1;this.delay=1000;this.renderFreshness();this.fire('open',new Event('open'));this.staleTimer=setInterval(()=>this.watchdog(),5000);
        this.heartbeat=setInterval(()=>{if(socket.readyState===WebSocket.OPEN)socket.send('{"type":"ping"}');},30000);};
      socket.onmessage=e=>{if(socket!==this.socket)return;let msg;try{msg=JSON.parse(e.data);}catch{return;}
        if(msg.type==='pong')return;
        if(!this.updateFreshness(msg))return;
        for(const event of CloudEvents.adapt(msg))this.fire('message',new MessageEvent('message',{data:JSON.stringify(event)}));
        this.renderFreshness();
      };
      socket.onclose=()=>{if(socket!==this.socket)return;clearInterval(this.heartbeat);clearInterval(this.staleTimer);CloudEvents.lastStatus={};this.freshnessByDevice.clear();this.lastDataByDevice={};this.staleDevices.clear();if(this.closed)return;this.readyState=0;this.renderFreshness();this.fire('error',new Event('error'));
        this.retry=setTimeout(async()=>{try{const r=await fetch('/api/session',{cache:'no-store'});if(r.status===401){this.close();location.assign('/login.html');return;}}catch{}
          this.connect();},this.delay);this.delay=Math.min(this.delay*2,30000);};
      socket.onerror=()=>{}; // close handler owns recovery and visible status.
    }
    static adapt(msg) {
      if((msg.type==='init'||msg.type==='mac-status') && msg.data){
        const data=msg.data, device=msg.device||'default';
        CloudEvents.latestPorts??={};CloudEvents.lastStatus??={};CloudEvents.latestPorts[device]=data.ports;
        const fingerprint=JSON.stringify([data.connected,data.authenticated,data.connection?.phase,data.settings,data.protocol_extend,data.firmware_version,data.device_model,data.gateway_connected,Object.values(data.ports||{}).map(p=>[p.valid,p.enabledKnown])]);
        const changed=fingerprint!==CloudEvents.lastStatus[device];CloudEvents.lastStatus[device]=fingerprint;
        if(msg.type==='init')return [{...data,type:'init',device,...(msg.devices?{devices:msg.devices}:{})}];
        return changed?[{...data,type:'status',device}]:[];
      }
      if(msg.type==='telemetry') {
        if(!msg.bleConnected)return [];
        const ids={c1:1,c2:2,c3:3,a:4};
        const device=msg.device||'default';
        return msg.ports.map(p=>({type:'port_update',device,port_id:ids[p.id],data:{...p,enabled:CloudEvents.latestPorts?.[device]?.[ids[p.id]]?.enabled ?? false,enabledKnown:CloudEvents.latestPorts?.[device]?.[ids[p.id]]?.enabledKnown}}));
      }
      if(msg.type==='status' && 'deviceConnected' in msg && !('connected' in msg))return msg.deviceConnected?[]:[CloudEvents.offlineStatus(msg.device||'default')];
      return [msg];
    }
    close(){this.closed=true;this.readyState=2;window.removeEventListener('device-changed',this.renderFreshness);clearTimeout(this.retry);clearInterval(this.heartbeat);clearInterval(this.staleTimer);const s=this.socket;this.socket=null;s?.close();}
  }
  window.EventSource=class extends CloudEvents {
    constructor(url,options){if(new URL(url,location.href).pathname!=='/api/events')return new NativeEventSource(url,options);super(url);}
  };
})();
