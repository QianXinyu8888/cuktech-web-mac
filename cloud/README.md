# Cloudflare 实验版

本目录包含网站、实时连接和充电历史服务。页面沿用 Mac 版的界面；ESP32 通过加密 WebSocket 连接，浏览器通过密码登录。当前实现仍需真实充电器、断网及重启测试，不能作为安全断电保护。

## 本地测试

在本目录运行 `npm ci`、`npm test` 和 `npm run dry-run`。`npm run dev` 启动本地服务；测试和构建前会从原有网页生成被忽略的 `public/` 文件。不要把真实密码或设备凭据写入源码、测试数据或 Git。

## 部署概要

使用 Cloudflare Workers 和 SQLite Durable Objects，先创建 Worker，再通过 Cloudflare Secret 配置 `VIEWER_PASSWORD`、`SESSION_SECRET` 和 `DEVICE_TOKEN`，并绑定自己的自定义域名。三个值应分别随机生成且保密；域名和设备配置应保存在被忽略的本地文件中。`workers_dev` 默认关闭。生产部署前应检查账户计划、免费额度和自定义域名，避免覆盖已有站点。

ESP32 的配置、配网安全和当前限制见 [固件说明](../src/cuktech-ble-ha-main/esp32_ble/CLOUD.md)。历史数据受 Cloudflare 存储与写入额度约束；多设备及长时间运行前请观察实际用量。网关掉电会丢失尚未上传的缓存。
