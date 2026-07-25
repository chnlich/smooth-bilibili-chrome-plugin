# Bilibili 桌面网页抗卡

长期产品约束见 [GOAL.md](GOAL.md)。视频和直播是同等重要的防卡目标：视频由 Bilibili 原生下载器在每次出现新的播放器或媒体内容时请求一次 120 秒缓存目标；直播由 Bilibili 原生播放器正常立即开播，真实网络卡顿后的自然延迟尽量保留，不自动追到直播点。

## 当前行为

- `/video/*` 与 `/list/watchlater*` 使用同一视频增强。扩展只对当前原生播放器尝试一次 120 秒稳定缓存目标，并只读显示覆盖当前播放点的 `video.buffered` 连续区间；不调用 `play()`/`pause()`，不写播放位置、倍速、画质、音量、静音、source，也不自建媒体下载管线。
- `live.bilibili.com/*` 始终使用 Bilibili 原生 video。扩展只观察媒体事实，在首帧后确认真实 waiting/stalled 或持续无新解码帧时，尽量保留卡顿自然形成的延迟；不初始暂停、不形成库存、不追直播点、不提供恢复动作按钮，也不接触 `playbackRate`。
- 用户和 Bilibili 的播放、暂停、拖动、倍速、画质、音量选择始终有效。普通换画质或 source/video 替换只重新绑定；只有确认发生真实卡顿并保存了延迟时，才按仍可播放的时间位置恢复旧延迟。
- popup 只显示增强开关和可直接读取的事实。视频显示实际连续缓存秒数、120 秒目标状态和错误；直播显示暂停、最近一秒新画面、连续缓存、可计算延迟、原生分辨率/画质、用户速度、替换次数、最近媒体事件或错误、日志 session 与持久化状态。没有阶段字段和恢复按钮。

## 安装

需要 Node.js 20+ 与 Chrome/Chromium 120+：

```sh
npm ci
npm run build
```

Windows 上运行真实 Chrome 的 A/B harness 时，从 Windows checkout 执行以下安装和构建命令。它使用系统 Chrome，不下载 Playwright Chromium：

```bat
cd /d E:\workspace\smooth-bilibili-chrome-plugin
set "PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1"
E:\tools\node\npm.cmd install
E:\tools\node\npm.cmd run build
E:\tools\node\node.exe scripts\stall-ab.mjs --self-check --profile "<persistent-signed-in-profile-dir>"
```

在 `chrome://extensions` 开启开发者模式，选择 `dist/extension` 加载未打包扩展。源代码或构建产物更新后，在扩展页手动点击“重新加载”，再刷新已经打开的 Bilibili 页面。本仓库已提交可直接加载的 `dist/extension`，包括 MV3 service worker、页面桥接、控制器、popup、开发日志页和外部 source map。

扩展只申请 `storage` 与 `unlimitedStorage`，没有 `tabs`、`downloads` 或宽泛 host permission。内容脚本会覆盖 `www.bilibili.com` 以便记录无关路由诊断，但视频增强只在批准的两个视频路由启动。

## 偏好与开发日志

popup 的“直播增强”和“视频增强”是刷新后的默认开关；关闭后仍会建立 session 并记录诊断，只是不启动对应增强。popup 的“打开开发日志”使用 `chrome.runtime.getURL('logs.html')` 打开扩展页，不需要新增权限。

日志页可选“当前 session”或“全部 session”。点击导出后先固定最大 `eventId`，由用户在 File System Access 对话框选择文件；JSONL 先写 `recordType: "session"`，再分页写 `recordType: "event"`，逐行等待写入，不一次性加载全部日志。取消或写入失败会明确显示并中止文件句柄。

日志记录包括独立记录身份、连续编号、播放器和媒体来源的更换记录、所有实际触发的标准媒体事件（包括 `volumechange`）、每秒完整 buffered/seekable ranges、资源 timing 与字节字段、120 秒提示、真实直播卡顿/延迟/换源/保护、桥接、生命周期和保存结果。日志不上传，不保存 Cookie、账号、页面文字、聊天、API body、签名 query、媒体字节、帧或截图。

## Stall A/B harness

`stall-ab` 用同一个 document-start probe 在真实 Bilibili 视频页上测量 extension-on 和 extension-off 两个 arm。它随机化 arm 顺序，在每个 arm 前清理 profile 的 media cache，并把 extension-on 的 `logs:events-page` 全量分页结果自动写出，不需要点击日志页的导出按钮。

stall A/B 只使用一个持久化 profile，profile 必须放在仓库外。先在 `chrome://extensions` 开启开发者模式，把 `dist/extension` 作为未打包扩展安装到这个 profile，一次即可。当前 Chrome 不可用命令行 `--load-extension`，harness 不再传入它或 `--disable-extensions-except`。extension-on 通过移除 Playwright 默认的 `--disable-extensions` 使用 profile 中的扩展；extension-off 保留 Playwright 默认设置，让同一个扩展保持不活动。这样两个 arm 共享登录和 Cookie 状态。`--login` 也使用这个 profile，并保留 `--mute-audio` 与 document-start 静音 guard。

`--self-check` 会用 extension-on 配置打开一个匹配扩展的 Bilibili 视频页，并检查 shim marker 与非原生的 `SourceBuffer.prototype.remove`，确认扩展真的注入；它不会播放视频，也不会记录 probe。测量开始前每个 arm 都会执行同样的检查，arm 状态不符合预期时以 `BLOCKED` 和非零状态退出，不会写出 `compare.json`。

先用持久化 profile 完成一次人工登录：

```bat
E:\tools\node\node.exe scripts\stall-ab.mjs --login --profile "<persistent-signed-in-profile-dir>"
```

后续运行使用同一个 profile：

```bat
E:\tools\node\node.exe scripts\stall-ab.mjs --bv BV1syga6fEL7 --seconds 180 --rate 2 --arms extension-on,extension-off --profile "<persistent-signed-in-profile-dir>" --out artifacts\stall-ab-20260724T000000Z
```

成功的输出目录包含两个 arm 的 `probe.jsonl` 与 `metric.json`、extension-on 的 `extlog.jsonl` 和 `compare.json`。`compare.json` 只报告 Phase 1 gate，不自动改变播放行为。登录失效、页面不可达、没有原生 video、profile 被其他 Chrome 实例占用，或扩展 arm 没有处于预期状态时，命令以非零状态报告 `BLOCKED`，不会伪造比较结果。

如果 profile 已被另一个 Chrome 窗口打开，命令会快速以 `PROFILE_IN_USE` 和非零状态失败；关闭那个窗口后再运行。

## 构建与验证

```sh
npm test
npm run smoke:external
npm audit --json
npm audit --omit=dev --json
```

构建保持未压缩并为每个 JavaScript bundle 生成外部 source map。`buildId` 由 `src` 内容确定性生成；源码不变时连续构建的文件内容、文件列表和 build id 相同。stall A/B automation 使用 `--profile` 指定的 persistent signed-in profile；现有 deterministic browser tests 仍使用 fresh temporary profile。所有自动化浏览器都保持 `--mute-audio` 和 document-start 静音 guard；真实 Bilibili 页面受环境阻挡时只报告 `BLOCKED`，不伪造通过。
