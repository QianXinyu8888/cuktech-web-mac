# 第三方来源与许可

- 本项目包含并修改了 [kairui1108/cuktech-ble-ha](https://github.com/kairui1108/cuktech-ble-ha) 的源码，保留其 MIT LICENSE 及版权声明。导入时没有可验证的上游提交 SHA，因此不宣称与某个上游版本完全一致。
- 浏览器包含 Chart.js 4.4.7（`ble_server/web/static/chart.umd.min.js` 及 ESP32 压缩副本），采用 MIT 许可，完整许可见 [licenses/Chart.js-MIT.txt](licenses/Chart.js-MIT.txt)，保留文件头中的版权及许可链接：https://github.com/chartjs/Chart.js/blob/v4.4.7/LICENSE.md 。
- `web/static/plugin_imgs/` 与 ESP32 中对应图片是随上游提供的产品界面素材。未发现独立授权证明；保留此来源说明不代表取得再许可或商用许可。产品名称、标志、界面图片权利归各自权利人。若权利人提出异议，应及时移除或替换。
- Python / ESP-IDF / Home Assistant 等依赖遵循各自许可；虚拟环境和编译产物不包含在本源码仓库中。
- 根目录使用说明截图为本项目空白配置界面，不包含真实账号、设备或充电历史。上游测试协议帧已去除录制者和绝对时间元数据，仅保留匿名协议回归素材。
