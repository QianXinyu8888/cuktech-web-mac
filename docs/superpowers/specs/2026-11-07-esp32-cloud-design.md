# ESP32-S3 远程实时查看

用户已确认采用 ESP32→Cloudflare→远程网页，不接入 Home Assistant，优先免费和平滑更新。先实现可独立验证的实时查看版本；功能范围的补充选择与自定义域名正等待用户答复，先按实时查看默认实现，长期历史/远程控制不在本次默认范围。

## 数据流与边界

ESP32沿用现有MiOT BLE状态机，新增独立WSS上传任务。Cloudflare Worker完成设备/查看者认证，同一个SQLite-backed Durable Object提供hibernating WebSocket协调，静态网页显示四端口状态与浏览器打开期间的近期曲线。Mac版本保留。

ESP32配置 cloud_url（wss://.../api/device）、cloud_token（仅设备上传）、cloud_enabled，配置只进入NVS。TLS证书链/主机名验证开启；SNTP时间同步后才连接云端。独立任务采样主程序互斥锁快照，不从蓝牙回调阻塞网络，不共享HTTP cJSON池。

## v1协议

设备发送 {type:"telemetry",version:1,seq:非负安全整数,uptimeMs:非负数,bleConnected:布尔,ports:[{id:"c1"|"c2"|"c3"|"a",voltage:数值,current:数值,power:数值,active:布尔,valid:布尔,protocol:短字符串}]}，四端口齐全且无重复。不得上传MAC、Wi-Fi、Mi Home Token、BLE Key或其他配置。

云端发回 {type:"rate",intervalMs:1000|30000}；有人查看时每秒最多一条合并四端口快照，无人查看时30秒一条。WebSocket协议心跳与自动重连独立。云端向查看者转发经过白名单验证的数据并加receivedAt（服务器毫秒时间）。设备无法冒充查看者，查看者无法上传遥测；不实现远程控制命令。

浏览器用独立密码登录，服务端签名HttpOnly/Secure/SameSite cookie，不把设备Token放浏览器。登录及WebSocket检查同源；限制消息体积/非法数值并关闭违规连接。只有一个生产者连接，重连替换旧连接。所有secret用Cloudflare secrets，示例仅占位。网页根据15秒无新数据标记失联，同时区分BLE未连接与未测得读数。数值使用短动画，曲线仅记录真实接收点，不伪造测量值。浏览器内最多1800点（30分钟）；刷新清空近期曲线，页面明确说明。

## 免费额度控制

使用WebSocket Hibernation，无setInterval常驻DO，无按秒数据库写入；最新快照存于设备socket attachment（小于2048 bytes），构造时从活动socket恢复。设备socket断开时通知查看者并保留页面最后读数为历史状态，不冒充在线。新连接无有效数据时显示等待。长期存储单独评估，先不自动开通付费服务。

## 验收

Node/Workers测试覆盖权限隔离、Cookie过期、恶意Origin、非法数据/重复端口、速率协调、生产者替换、休眠恢复。真实浏览器验证登录/实时变化/断线状态/手机布局。ESP-IDF对S3实际编译，设备连接后先只读确认芯片并备份原Flash，再刷写验证；无真实BLE凭据时不能宣称已完成真实充电器验收。自定义域名需用户提供后才能绑定。
