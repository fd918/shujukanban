# 美团联盟活动看板

这是一个静态活动看板，用于查看美团联盟活动的核销金额、档位缺口、预计奖励，并支持手动覆盖每日金额。

## 使用方式

直接打开 `index.html` 或 `meituan-dashboard-preview.html`。

## 刷新接口数据

1. 复制 `.env.example` 为 `.env`。
2. 在 `.env` 中填写请求标头文件位置。
3. 在项目根目录执行：

```bash
node scripts/refresh-meituan-data.mjs 1199
```

脚本会全量刷新接口返回的每日数据，并保留看板里手动输入的覆盖值。

如果要定时刷新，例如每 10 分钟刷新一次，在项目根目录执行：

```bash
node scripts/watch-refresh.mjs 10
```

如果要让页面里的“立即刷新数据”按钮生效，需要先启动本机刷新服务：

```bash
node scripts/local-refresh-server.mjs
```

## 安全注意

`.env` 中包含 Cookie 和 mtgsig，不能上传到 GitHub，也不能发给别人。
