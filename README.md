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

## 后台常驻刷新

后台服务脚本是：

```bash
node scripts/background-refresh-service.mjs
```

配置文件在 `data/watch-config.json`：

- `intervalMinutes`：刷新间隔，默认 30 分钟。
- `primaryActivityId`：公开看板默认展示的活动 ID。
- `activityIds`：后台需要记录小时快照的活动 ID 列表。
- `autoPush`：是否刷新后自动提交并推送到 GitHub。

每次刷新成功后，会写入小时快照：

```text
data/hourly-snapshots-活动ID.json
```

macOS 已配置 `launchd` 常驻任务：

```text
~/Library/LaunchAgents/com.tanwenjie.meituan-dashboard.plist
```

只要电脑开机并登录，该服务会在后台运行；关闭看板网页或终端窗口不会影响刷新。

日志文件：

```text
logs/background-refresh.log
logs/background-refresh-error.log
```

## 桌面入口

桌面已生成快捷入口：

```text
~/Desktop/美团数据看板.command
```

双击即可打开本地看板页面。

后台服务控制入口：

```text
~/Desktop/美团看板服务.command
```

双击后可以选择查看状态、启动服务、停止服务、重启服务，或打开本地看板。

## 对外访问

推荐用 GitHub Pages 对外展示静态看板。后台服务刷新后会尝试执行：

```bash
git add index.html meituan-dashboard-preview.html README.md .gitignore .env.example scripts assets data
git commit -m "Update Meituan dashboard ..."
git push origin main
```

注意：GitHub 自动推送需要本机命令行 GitHub 凭证可用。网页里登录 GitHub 不等于命令行 `git push` 已登录。

## 安全注意

`.env` 中包含 Cookie 和 mtgsig，不能上传到 GitHub，也不能发给别人。
