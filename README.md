# Bilibili 桌面网页抗卡

长期产品约束见 [GOAL.md](GOAL.md)。视频和直播是同等重要的防卡目标：视频由 Bilibili 原生下载器按每个新媒体代一次的 120 秒缓存目标积极提前缓存；直播由 Bilibili 原生播放器正常立即开播，真实网络卡顿后的自然延迟尽量保留，不自动追到直播点。

## 当前行为

- `/video/*` 与 `/list/watchlater*` 使用同一视频增强。扩展只对当前原生播放器内核尝试一次 120 秒稳定缓存目标，并只读显示覆盖当前播放点的 `video.buffered` 连续区间；不调用 `play()`/`pause()`，不写播放位置、倍速、画质、音量、静音、source，也不自建媒体下载管线。
- `live.bilibili.com/*` 始终使用 Bilibili 原生 video。扩展只观察媒体事实，在首帧后确认真实 waiting/stalled 或持续无新解码帧时，尽量保留卡顿自然形成的延迟；不初始暂停、不形成库存、不追直播点、不提供恢复动作按钮，也不接触 `playbackRate`。
- 用户和 Bilibili 的播放、暂停、拖动、倍速、画质、音量选择始终有效。普通换画质或 source/video 替换只重新绑定；只有 active genuine stall protection 存在时才按仍可播放的 seekable 位置恢复旧延迟。
- popup 只显示增强开关和可直接读取的事实。视频显示实际连续缓存秒数、120 秒目标状态和错误；直播显示暂停、最近一秒新画面、连续缓存、可计算延迟、原生分辨率/画质、用户速度、替换次数、最近媒体事件或错误、日志 session 与持久化状态。没有阶段字段和恢复按钮。

## 安装

需要 Node.js 20+ 与 Chrome/Chromium 120+：

```sh
npm ci
npm run build
```

在 `chrome://extensions` 开启开发者模式，选择 `dist/extension` 加载未打包扩展。源代码或构建产物更新后，在扩展页手动点击“重新加载”，再刷新已经打开的 Bilibili 页面。本仓库已提交可直接加载的 `dist/extension`，包括 MV3 service worker、页面桥接、控制器、popup、开发日志页和外部 source map。

扩展只申请 `storage` 与 `unlimitedStorage`，没有 `tabs`、`downloads` 或宽泛 host permission。内容脚本会覆盖 `www.bilibili.com` 以便记录无关路由诊断，但视频增强只在批准的两个视频路由启动。

## 偏好与开发日志

popup 的“直播增强”和“视频增强”是刷新后的默认开关；关闭后仍会建立 session 并记录诊断，只是不启动对应增强。popup 的“打开开发日志”使用 `chrome.runtime.getURL('logs.html')` 打开扩展页，不需要新增权限。

日志页可选“当前 session”或“全部 session”。点击导出后先固定最大 `eventId`，由用户在 File System Access 对话框选择文件；JSONL 先写 `recordType: "session"`，再分页写 `recordType: "event"`，逐行等待写入，不一次性加载全部日志。取消或写入失败会明确显示并中止文件句柄。

日志记录包括 session 身份、连续 sequence、video/source/core generation、所有实际触发的标准媒体事件（包括 `volumechange`）、每秒完整 buffered/seekable ranges、资源 timing 与字节字段、120 秒提示、真实直播卡顿/延迟/换源/保护、桥接、生命周期和保存结果。日志不上传，不保存 Cookie、账号、页面文字、聊天、API body、签名 query、媒体字节、帧或截图。

## 构建与验证

```sh
npm test
npm run smoke:external
npm audit --json
npm audit --omit=dev --json
```

构建保持未压缩并为每个 JavaScript bundle 生成外部 source map。`buildId` 由 `src` 内容确定性生成；源码不变时连续构建的文件内容、文件列表和 build id 相同。自动化浏览器始终使用 fresh temporary profile、`--mute-audio` 和 document-start 静音 guard；真实 Bilibili 页面受环境阻挡时只报告 `BLOCKED`，不伪造通过。
