# Bilibili 桌面网页抗卡

长期产品约束见 [GOAL.md](GOAL.md)。视频由 Bilibili 原生下载器在每次出现新的播放器或媒体内容时请求一次 120 秒缓存目标。

## 当前行为

- `/video/*` 与 `/list/watchlater*` 使用同一视频增强。扩展同步查找视频页媒体分片的内存缓存，命中时由下载层回应，未命中时让播放器原样发出自己的请求；下载层仍可提前预取，分片只在实例内存中保存，离开视频路由或页面关闭即释放，不落盘；仍只对当前原生播放器尝试一次 120 秒稳定缓存目标，并只读显示覆盖当前播放点的 `video.buffered` 连续区间。不接管播放，不调用 `play()`/`pause()`，不写播放位置、倍速、画质、音量、静音、source，也不改变播放器的清晰度、seek、播放暂停或音视频轨决策。
- popup 只显示视频增强开关和可直接读取的事实：实际连续缓存秒数、120 秒目标状态和错误。

## 下载层

- 缓存未命中时记一条 `bank.serve` 的 `result: 'pass'` / `reason: 'miss'`，下载层不发网络请求、不创建拦截状态，播放器的原始 `fetch`/`XHR`、URL、headers、Range 和 body 原样直达网络；在途预取继续运行，不因让路中止。
- 命中时由内存中的完整分片回应。分片只存在 `Map` 里，不落盘。
- 调度器只运行投机预取：分片按边界对齐，并发上限 2，死线 20 秒；成功的预取是唯一入库来源。
- 让路响应只读 `Content-Range` header 以学习文件总长度，不读取、复制或持有响应体；没有该 header 时本轮预取跳过。
- 分片 4 MiB、预取前方 900 秒、内存上限 512 MiB。

## 安装

需要 Node.js 20+ 与 Chrome/Chromium 120+：

```sh
npm ci
npm run build
```

Windows 上运行真实 Chrome 测试时，从 Windows checkout 执行以下安装和构建命令。它使用系统 Chrome，不下载 Playwright Chromium：

```bat
cd /d E:\workspace\smooth-bilibili-chrome-plugin
set "PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1"
E:\tools\node\npm.cmd install
E:\tools\node\npm.cmd run build
```

在 `chrome://extensions` 开启开发者模式，选择 `dist/extension` 加载未打包扩展。源代码或构建产物更新后，在扩展页手动点击“重新加载”，再刷新已经打开的 Bilibili 页面。本仓库已提交可直接加载的 `dist/extension`，包括 MV3 service worker、页面桥接、控制器、popup、开发日志页和外部 source map。

扩展只申请 `storage` 与 `unlimitedStorage`，没有 `tabs`、`downloads` 或宽泛 host permission。内容脚本会覆盖 `www.bilibili.com` 以便记录无关路由诊断，但视频增强只在批准的两个视频路由启动。

## 偏好与开发日志

popup 的“视频增强”是刷新后的默认开关；关闭后仍会建立 session 并记录诊断，只是不启动视频增强。popup 的“打开开发日志”使用 `chrome.runtime.getURL('logs.html')` 打开扩展页，不需要新增权限。

日志页可选“当前 session”或“全部 session”。点击导出后先固定最大 `eventId`，由用户在 File System Access 对话框选择文件；JSONL 先写 `recordType: "session"`，再分页写 `recordType: "event"`，逐行等待写入，不一次性加载全部日志。取消或写入失败会明确显示并中止文件句柄。

日志记录包括独立记录身份、连续编号、播放器和媒体来源的更换记录、所有实际触发的标准媒体事件（包括 `volumechange`）、每秒完整 buffered/seekable ranges、资源 timing 与字节字段、120 秒提示、桥接、生命周期和保存结果。日志不上传，不保存 Cookie、账号、页面文字、聊天、API body、签名 query、媒体字节、帧或截图。

## 构建与验证

```sh
npm test
npm run smoke:external
npm audit --json
npm audit --omit=dev --json
```

构建保持未压缩，并为每个 JavaScript bundle 生成外部 source map。`buildId` 由 `src` 内容确定性生成；源码不变时连续构建的文件内容、文件列表和 build id 相同。现有确定性浏览器测试仍使用新建的临时 profile。所有自动化浏览器都保持 `--mute-audio` 和 document-start 静音 guard；真实 Bilibili 页面受环境阻挡时只报告 `BLOCKED`，不伪造通过。

浏览器脚本明确使用系统 Chrome，不回退到 Playwright Chromium。默认路径是 `C:\Program Files (x86)\Google\Chrome\Application\chrome.exe`，也可以用 `BILIBILI_E2E_CHROME` 覆盖。`npm run test:e2e` 使用临时 profile；真实播放验收使用 `npm run verify:browser -- --profile <专用登录 profile> --bv <BV号>`。验证输出目录包含 `events.json`、`console.json`、`network.json` 和 `summary.json`；`summary.json` 会记录 commit sha、buildId，以及 `pass`、`fail` 或 `INCONCLUSIVE` 和失败项。

## 自己验证

1. 执行 `npm run build` 后，在 `chrome://extensions` 加载 `dist/extension`。
2. 打开一个**播放量 1000 以下的冷门视频**（热门视频被 CDN 预热会掩盖问题）。
3. 在 popup 中打开开发日志页，观察：`bank.serve` 的 hit/miss 随播放时长的变化、`bank.fetch.chunk` 有没有 `result: 'deadline'`、有没有 `bank.disabled`。
