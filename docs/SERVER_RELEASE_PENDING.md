# 服务器待发布功能

状态：无待发布项

最后发布：2026-08-07 14:10

用户信息统一样式已推送 GitHub，并已更新正式服务器。

## 待发布

当前没有待发布功能。

## 发布结果

- 流失看板备份：`C:\apps\yunzhan-dashboard-server\backups\mail-churn-four-source-20260807-120021`
- 流失看板原子更新备份：`C:\apps\yunzhan-dashboard-server\backups\update-20260807-120046`
- 激励活动看板备份：`C:\apps\yunzhan-dashboard-server\backups\update-20260807-120958`
- 游客登录保护备份：`C:\apps\yunzhan-dashboard-server\backups\update-20260807-134927`
- 用户信息统一样式备份：`C:\apps\yunzhan-dashboard-server\backups\update-20260807-140903`
- 用户信息统一样式正式文件 SHA-256：`business-user-dashboard-prototype.html=95eac4df31e0fc2c0e01bc6fc3895a0156e39f789b34fee2b1c270cb2747db37`、`business-churn-dashboard-prototype.html=2e317b9f3de23b046e3d3ea6e160f62d05601cfcd9427aab73cf18608dec717f`、`shared-business-user-data.js=757c2609c34fc368ecf60c59c364f320598972dd9f016f4b945facf7920ad511`。
- 用户信息统一样式公网实测：业务用户列表正常打开，姓名、ID、版本与完整手机号按统一结构展示；ID 和手机号均已验证真实写入系统剪贴板。流失看板正式页面结构确认直接显示接口手机号，不再前端脱敏。
- 本次仅替换上述三个用户展示文件；`dashboard-live-server.mjs` 与 `index.html` 发布前后哈希一致，未覆盖后端、数据、环境变量、DPAPI、账号或任务脚本。
- 游客登录保护：匿名首页返回 302 并跳转登录页；登录页 HTTP 200；游客账号当前未配置，管理员原账号密码未修改。
- 公网健康检查：HTTP 200。
- Windows 任务：`YunzhanDashboardWeb`、`YunzhanDashboardRefresh` 均为 `Running`。
- 邮件同步：2026-08-07 12:04 已通过专用令牌完成一次真实推送；四个来源数据均完整到 2026-08-06。

## 后续规则

新的本地功能再次累计在本文档中；完成服务器备份、替换、重启和公网验收后再清空。
