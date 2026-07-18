# Bilibili 桌面网页抗卡

这是一个双模式 Manifest V3 Chrome 扩展：直播页使用连续的 HLS/fMP4 缓冲管线，视频页使用 Bilibili 当前播放器内核的公开/观察到的 `requestQuality(64)`、2× 播放和连续前向缓冲策略。直播与点播是互斥入口，同一个标签页不会同时运行两个控制器。

固定 userscript 行为合同迁移自已审核版本的 `src/live/*`、`src/vod/*`、`src/constants.js`、`src/errors.js`、`src/ui/*` 及对应测试；扩展新增的执行边界在 `src/extension/`。扩展不再读取 userscript 资源、不执行运行时字符串代码，也不修改原 userscript 仓库。

## 构建和加载

需要 Node.js 20 或更高版本，以及 Chrome/Chromium 120 或更高版本。

```sh
npm ci
npm run build
```

构建结果是已提交的 `dist/extension/`。在 Chrome 地址栏打开 `chrome://extensions`，开启“开发者模式”，点击“加载已解压的扩展程序”，直接选择 `dist/extension`，不需要先运行本地服务器，也不需要 zip 文件。

代码或构建结果更新后，在扩展管理页点击“重新加载”，然后刷新已经打开的 Bilibili 页面。弹窗开关只影响下一次页面刷新；当前页面可使用面板里的“停用”立即停止当前控制器，再次点击“启用”恢复当前页的控制器活动。

弹窗提供两个独立开关：

- `直播增强`：仅控制 `live.bilibili.com` 页面。
- `视频增强`：仅控制 `www.bilibili.com/video/` 页面。

首次安装没有存储值时两项均视为开启。扩展只在 `chrome.storage.local` 保存这两个布尔偏好，不保存媒体、账号、Cookie、页面内容或播放历史。卸载时，在 `chrome://extensions` 找到本扩展并点击“移除”；卸载会同时删除扩展自身的本地偏好。

## 直播模式

直播从当前直播边缘以 1× 开始，不预先等待 60 秒，不自动追赶、前跳、回到直播、变速、跳过序号或丢弃尚未连续消费的延迟片段。每个必需序号按 init/media 的严格连续顺序进入 MSE，同一清晰度的 CDN 候选在每一轮并发竞速，暂时性网络错误、超时、5xx 和签名失效会重试同一个序号。停顿后连续前向库存达到 15 秒才恢复，并向约 60 秒积极填充。

清单回退、变体/媒体片段滑出、精确变体或 map 变化、永久 404、MSE append/remove 错误、队列冻结以及页面夺回媒体 source 都会进入 `GAP_UNRECOVERABLE`。此时面板提供“跨过缺口”和“回到直播”；任何定时器都不会自动点击这些按钮。普通清单 503/超时保持可恢复。手动“回到直播”会取消旧请求，获取同清晰度的新边缘，重建 MSE 并恢复播放。延迟超过 3 秒时会隐藏弹幕/聊天节点，恢复时会保留原节点和原显示状态；覆盖 `danmaku`、`.chat-history-panel`、`#chat-history-list`、`#chat-items` 及动态重建节点。

面板常见状态包括 `STARTING`、`LIVE`、`STALL`、`RECOVERING`、`DELAYED`、`USER_PAUSED`、`GAP_UNRECOVERABLE` 和 `ERROR`。`回到直播`会在不可恢复缺口、延迟、用户暂停和真实恢复积压时显示。

## 视频模式

视频模式只通过 MAIN world 的版本化桥接访问当前 `player.__core()`，桥接只传递可序列化的播放器/内核白名单字段和事件；fetch、定时器、HLS、MSE、状态机和 Shadow DOM 面板都由 ISOLATED world 控制器拥有。扩展不会读取或覆盖页面的 `window.Hls`，也不调用隐藏的 `setQuality`、`setQn` 或 `setVideoQuality`。

扩展只调用 `requestQuality(64)` 请求 720P，并通过真实 getter/事件确认结果。面板会区分已确认、拒绝、不可用和超时；确认后的同一 BVID/分 P/内核/资源出现真实 qn32 漂移时，会创建新观察并再次请求 qn64。初始和补水目标为 120 秒或短视频剩余时长，连续前向库存低于 30 秒才会为补水暂停；用户主动暂停不会被自动恢复。播放速度固定为 2×，稳定缓冲目标为 180 秒；MSE 配额按 180→120→90 秒降级，并在同一 BVID/分 P 的内核、资源和画质重建后保留。

视频页面板状态通常为 `VOD_READY`、`REFILLING`、`USER_PAUSED` 或 `ERROR`，画质文字只有在真实确认后才显示 `qn64 已生效`。扩展不绕过登录、会员、地区、版权、DRM 或任何 Bilibili 授权；手动验证 720P 时，请使用已登录且有权限的普通 Bilibili 视频，在弹窗打开“视频增强”，刷新页面，确认面板显示 `720P/qn64 已生效` 和 `2×`，并观察页面实际播放质量。若当前账号或视频不可用 720P，面板必须显示真实失败原因。

## 权限、隐私和限制

Manifest 是 MV3，最低 Chrome 版本为 120，没有 service worker、options page、代理、服务器、持久 DVR 或第三种页面模式。内容脚本只匹配 `https://live.bilibili.com/*` 和 `https://www.bilibili.com/video/*` 的顶层页面，并在 `document_start` 执行。

扩展请求 `storage`，以及实现产品 fetch 所需的 `https://api.live.bilibili.com/*` 和 Bilibili CDN `https://*.bilivideo.com/*`。这些权限只用于官方播放信息、HLS 清单和媒体片段请求，所有产品请求都使用 `credentials: omit`。没有 Cookie/profile 读取，没有遥测、分析 SDK、外部字体、远程可执行代码或媒体持久化；媒体只存在于当前页面的内存 MSE 中。

可用带宽、浏览器编解码器、Bilibili 登录状态、会员/地区授权和官方 CDN 状态都会限制效果。扩展不会承诺超过当前网络带宽，也不会将授权失败伪装成成功。Linux 自动化若缺少 H.264 编解码器，外部直播 smoke 可以是 `BLOCKED`；这不等同于真实 Bilibili 通过，确定性实际媒体加载测试仍必须通过。

## 测试和验证

```sh
npm ci
npm run build
npm run test:unit
npm run test:contract
npm run test:e2e
npm test
npm audit --json
npm audit --omit=dev --json
npm run smoke:external
```

`test:unit` 包含固定源的 53 个媒体回归和扩展桥接/Manifest 测试。`test:contract` 检查 MV3、最小 Chrome 版本、精确 match/top-frame/document-start/world、权限、固定 `hls.js@1.5.17`、popup 资源、source/dist 禁止项和生成结果一致性。`test:e2e` 使用 Playwright `launchPersistentContext` 加载提交的 `dist/extension`，验证扩展 runtime id、MAIN↔ISOLATED 桥接、弹窗/storage、默认开启、刷新语义、直播/点播路由、实际静音视频的 `currentSrc`/`readyState`/播放进度、点播 2× 和直播 Fake MSE 的并发 CDN/连续 append。每次浏览器运行都使用新的临时 profile、headless、`--mute-audio`，并在每次测试播放前同步断言所有 audio/video 为 `muted=true`、`volume=0`；测试结束清理 profile 和临时库。

`smoke:external` 使用新的匿名临时 profile 访问批准的 VOD URL 和房间 6363772；若该房间离线，只选官方推荐列表中当前 `live_status=1` 的房间。每个子测试严格报告 `PASS`、`BLOCKED` 或 `FAIL`，任何 `BLOCKED`/`FAIL` 都以非零退出；反爬、匿名页面没有播放器、网络环境或编解码器缺失只能报告 `BLOCKED`，不能宣称真实页面通过。产品断言、桥接错误、扩展错误和错误状态均为 `FAIL`。报告写入被忽略的 `reports/`，不会提交到仓库。

Windows 已安装 Chrome 的手工/自动化尝试必须仍使用新的临时 profile、headless、静音和 document-start 静音守卫；若 Chrome 版本拒绝命令行加载解压扩展，应记录为自动化限制，不得使用个人 profile、Cookie 或策略绕过。正式使用前请在目标 Chrome 中通过“加载已解压的扩展程序”加载 `dist/extension`，分别手动验证直播和一个已登录、确实授权 720P 的点播视频。
