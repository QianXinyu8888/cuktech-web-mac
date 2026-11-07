# 完整迁移进度

用户最终域名：charge.example.com。范围见 ../specs/2026-11-07-esp32-full-migration.md。

- [x] 确认S3硬件：16MB Flash、8MB PSRAM。
- [x] 原固件16MB只读备份到忽略的backups/，权限600。
- [x] 云端遥测/登录与权限基础，13项测试和dry-run通过。
- [ ] S3 WSS基础固件编译/配置验证（进行中）。
- [ ] 完整历史与算法迁移及API行为对照。
- [ ] 控制回执、离线自动化与设置迁移。
- [ ] 复用原有完整UI与远程传输。
- [ ] 米家扫码导入与网关管理。
- [ ] 测试、审查、域名绑定与真实充电器验收。

约束：不将只读演示标为完成；源代码不包含个人域名、账号或设备密钥（私有域名配置通过忽略的wrangler override）。任何公开push前重跑publication guard。
