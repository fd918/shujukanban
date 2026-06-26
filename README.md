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

当前推荐直接使用“后台常驻刷新”里的 `launchd` 服务；它会同时提供定时刷新和页面“刷新数据”按钮需要的本机接口。

## 后台常驻刷新

后台服务脚本是：

```bash
node scripts/background-refresh-service.mjs
```

该服务同时做两件事：

- 每隔一段时间自动刷新活动数据。
- 提供页面“刷新数据”按钮需要的本机接口：`http://127.0.0.1:8765/refresh`。

配置文件在 `data/watch-config.json`：

- `intervalMinutes`：刷新间隔，默认 30 分钟。
- `primaryActivityId`：公开看板默认展示的活动 ID。
- `activityIds`：后台需要记录小时快照的活动 ID 列表。
- `autoPush`：是否刷新后自动提交并推送到 GitHub。

刷新间隔由 `intervalMinutes` 控制，和快照文件本身没有绑定。也可以在看板“设置”里的“后台定时刷新”直接改为 10、20、30 或 60 分钟；修改后后台服务会按新间隔继续运行。

每次刷新成功后，会写入小时快照：

```text
data/hourly-snapshots-活动ID.json
```

macOS 已配置 `launchd` 常驻任务：

```text
~/Library/LaunchAgents/com.tanwenjie.meituan-dashboard.plist
```

只要电脑开机并登录，该服务会在后台运行；关闭看板网页或终端窗口不会影响刷新。
如果电脑异常关机，重新开机并登录系统后，`launchd` 会自动尝试启动该服务。若看板数据没有继续更新，双击桌面的“美团看板服务.command”，选择“查看服务状态”或“重启服务”即可恢复。

日志文件：

```text
logs/background-refresh.log
logs/background-refresh-error.log
```

## 桌面入口

后台服务控制入口：

```text
~/Desktop/美团看板服务.command
```

双击后可以选择查看状态、启动服务、停止服务、重启服务，或打开本地看板。
日常只保留这个入口即可：先确认服务运行，再选择“打开本地看板”。

## 手动输入保存

页面“预估数据”列的手动输入会保存两份：

- 浏览器本地保存：用于页面立即刷新后继续保留。
- 后台服务文件保存：写入 `data/manual-overrides.json`，用于浏览器重启或后续重新打开看板后恢复。

清空某一天输入框后，会恢复使用接口默认值，并同步清除后台保存文件里的对应日期。

## 新增或切换活动

最简单流程：

1. 打开看板右上角“设置”。
2. 在“新增活动 ID”里填写新的活动 ID。
3. 如果这个活动需要长期跟踪，勾选“记录快照”；如果只是临时查看，不要勾选。
4. 点击“新增并切换”。
5. 回到页面右上角点击“刷新数据”。

只有勾选“记录快照”的活动，刷新成功后才会写入 `data/watch-config.json` 的 `activityIds`，后续每 30 分钟继续记录该活动快照。未勾选的活动只会刷新当前页面数据，不会进入后台定时快照名单。

## 今日预估口径

后台刷新会记录半小时快照，并写入：

```text
data/hourly-snapshots-活动ID.json
```

看板顶部的“今日预估 GMV / 今日预估订单数”优先用当天快照结合前一天同时间进度曲线预估；如果历史曲线不足，则按当天时间进度粗略预估。凌晨当天接口还没返回数据时，页面会暂时显示最新有数据的日期，并在标签里写明日期。

## 对外访问

推荐用 GitHub Pages 对外展示静态看板。后台服务刷新后会尝试执行：

```bash
git add index.html meituan-dashboard-preview.html README.md .gitignore .env.example scripts assets data
git commit -m "Update Meituan dashboard ..."
git push origin main
```

注意：GitHub 自动推送需要本机命令行 GitHub 凭证可用。网页里登录 GitHub 不等于命令行 `git push` 已登录。
当前配置已开启自动推送：本机后台服务刷新成功后，会自动提交公开文件并推送到 GitHub，GitHub Pages 构建完成后，公网看板会自动显示最新发布数据。

公开 GitHub Pages 上的“刷新页面”只会重新加载已发布到 GitHub 的最新静态数据；真正请求美团接口的刷新只在本机后台服务里执行。不要把 Cookie、请求标头或 mtgsig 放到公开网页里。
公网访问时，设置弹窗只保留活动切换；新增活动、记录快照、后台刷新间隔、页面自动刷新等配置只在本机看板开放。

## 安全注意

`.env` 中包含 Cookie 和 mtgsig，不能上传到 GitHub，也不能发给别人。
当前公开仓库不会提交 `.env`、完整请求标头、手动输入保存文件或日志；但看板页面中的活动标题、活动规则图片、每日订单量、GMV、快照趋势等业务数据会公开展示。
