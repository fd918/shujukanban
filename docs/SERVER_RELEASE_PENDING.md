# 服务器待发布功能

状态：有 1 项待发布

最后发布：2026-08-07 13:49

游客登录保护已发布到正式服务器；以下用户信息统一样式仍未推送 GitHub，也未更新正式服务器。

## 待发布

1. 五处用户信息统一为“名称 + 修改 + 收藏、ID + 版本、手机号”三行紧凑结构；流失看板与邮件流失数据直接显示接口返回的完整手机号；全部位置的 ID 和手机号统一使用 iframe 中也能真实写入系统剪贴板的复制方式，并显示成功或失败提示。收藏后仅点亮星形图标，重点用户取消收藏保留二次确认。覆盖业务用户列表、流失用户、重点用户、营销费用和邮件流失用户，备注继续使用独立字段。

## 发布结果

- 流失看板备份：`C:\apps\yunzhan-dashboard-server\backups\mail-churn-four-source-20260807-120021`
- 流失看板原子更新备份：`C:\apps\yunzhan-dashboard-server\backups\update-20260807-120046`
- 激励活动看板备份：`C:\apps\yunzhan-dashboard-server\backups\update-20260807-120958`
- 游客登录保护备份：`C:\apps\yunzhan-dashboard-server\backups\update-20260807-134927`
- 游客登录保护：匿名首页返回 302 并跳转登录页；登录页 HTTP 200；游客账号当前未配置，管理员原账号密码未修改。
- 公网健康检查：HTTP 200。
- Windows 任务：`YunzhanDashboardWeb`、`YunzhanDashboardRefresh` 均为 `Running`。
- 邮件同步：2026-08-07 12:04 已通过专用令牌完成一次真实推送；四个来源数据均完整到 2026-08-06。

## 后续规则

新的本地功能再次累计在本文档中；完成服务器备份、替换、重启和公网验收后再清空。
