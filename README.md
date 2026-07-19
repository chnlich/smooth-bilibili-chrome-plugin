# Bilibili 桌面网页抗卡

这是一个双模式 Manifest V3 Chrome 扩展：直播页使用连续的 HLS/fMP4 缓冲管线，点播页使用 Bilibili 当前播放器的公开只读画质信息、2× 播放和连续前向缓冲策略。直播与点播是互斥入口，同一个标签页不会同时运行两个控制器。

固定 userscript 行为合同迁移自已审核版本的 `src/live/*`、`src/vod/*`、`src/constants.js`、`src/errors.js`、`src/ui/*` 及对应测试；扩展新增的执行边界在 `src/extension/`。扩展不读取 userscript 资源、不执行运行时字符串代码，也不修改原 userscript 仓库。

## 构建和加载

需要 Node.js 20 或更高版本，以及 Chrome/Chromium 120 或更高版本。

```sh
npm ci
npm run build
```

构建结果是已提交的 `dist/extension/`。在 Chrome 地址栏打开 `chrome://extensions`，开启“开发者模式”，点击“加载已解压的扩展程序”，直接选择 `dist/extension`，不需要本地服务器或 zip 文件。代码或构建结果更新后，在扩展管理页点击“重新加载”，再刷新已经打开的 Bilibili 页面。

工具栏 popup 是唯一的状态和动作界面。页面本身不会插入状态面板、host、Shadow DOM、徽章或样式。popup 每 500ms 查询当前活动标签页，并显示模式、状态、连续库存、延迟、画质、速度、倍率、阶段、消息和当前可见动作；没有可信值时显示 `未提供`。关闭 popup 只停止轮询，控制器继续运行；重新打开会读取当前状态，多个标签页的瞬时状态互不共享。

popup 的 `直播增强` 和 `视频增强` 是下次刷新页面的默认值，不会立即重建当前页面管线。popup 同时提供当前页面的 `启用/停用` 动作；它只控制当前页面，不把偏好开关当作即时重建操作。首次安装没有存储值时两项均视为开启。扩展只在 `chrome.storage.local` 保存这两个布尔偏好，不保存媒体、账号、Cookie、页面内容、播放历史或指标。

## 直播模式

直播从当前直播边缘以 1× 开始，不预先等待 60 秒，不自动追赶、前跳、回到直播、变速、跳过序号或丢弃尚未连续消费的延迟片段。每个必需序号按 init/media 的严格连续顺序进入扩展拥有的 MSE，同一清晰度的 CDN 候选在每一轮并发竞速；暂时性网络错误、超时、5xx 和签名失效会重试同一个序号。停顿后连续前向库存达到 15 秒才恢复，并向约 60 秒积极填充。

popup 会报告 `等待 video`、`配置播放器`、`播放信息`、`manifest`、`MSE`、`init`、`库存形成` 等阶段，以及尝试轮次和脱敏后的候选主机名。直播画质同时显示 Bilibili 当前的人类可读描述、qn 和 codec。延迟只有在 program-date-time 或连续 MSE 库存与当前清单边缘之间存在有效映射时才显示；没有锚点时显示 `未提供`，不会用未锚定的 `0.0 秒` 冒充实时延迟。下载倍率来自内存中的成功 manifest/init/segment 请求，使用实际字节数、媒体时长、完成时间以及 30/60 秒窗口；库存已满时显示 `库存已满`。

零库存的 `STARTING`/`RECOVERING` 代际共用一个绝对 45 秒 watchdog。库存形成后立即取消；换代、停用、手动重试、跨过缺口或回到直播也会取消旧计时器。45 秒到期仍无可解码连续库存时，popup 显示带阶段、脱敏主机、codec 的明确 GAP/错误和人工动作，不会无限停留在启动或恢复中。清单回退、变体/media segment 滑出、精确 codec/profile/session 或 map/init 变化、永久 404、MSE append/remove 错误、队列冻结以及页面夺回媒体 source 都会进入 `GAP_UNRECOVERABLE`；popup 会按当前可见性提供“跨过缺口”和“回到直播”。定时器不会自动点击这些动作。手动“回到直播”会取消旧请求，获取同清晰度的新边缘，重建 MSE 并恢复播放；延迟超过 3 秒时隐藏弹幕/聊天节点，恢复时保留原节点和显示状态。

直播的扩展-owned fMP4 必须同时声明非空 video/audio codec，init segment 也必须同时包含 video/audio track；muxed fMP4 合法，但不会为了补音频而偷偷建立第二条网络管线。缺少音频、组合 codec 不支持或无法形成可解码库存都报告为产品错误/GAP，静音视频不算成功。

## 点播模式

点播一绑定原生 video/audio source 就立即尝试播放并应用 2×；0、5 或 20 秒初始库存都不是启动门槛，Bilibili 原生播放器在后台积极向 120 秒下载。只有当前位置此前达到 120 秒目标、连续前向库存低于 30 秒、内核明确支持 paused scheduling，且不是用户暂停、seek 恢复期或片尾时，脚本才允许一次补水暂停；缺少该能力时保持播放并显示降级提示，不制造下载死锁。用户主动暂停不会被自动恢复，最后 30 秒不脚本暂停，独立 audio/video 尾部相差 0.05–1 秒时让浏览器自然进入 `ended`。

点播只通过 MAIN world 的版本化桥接访问当前播放器和 `player.__core()` 的实际能力快照。稳定缓冲、paused scheduling、公开只读 `getQuality`/`getSupportedQualityList`、buffer/media info 和 core events 分别判断；一个可选 API 缺失不会阻塞 2×、指标、画质或其他可用控制。稳定缓冲目标按现有的 180→120→90 秒 quota 会话策略逐级降级并保持每个内核幂等。

画质完全由 Bilibili 播放器和用户控制，扩展没有画质写入口、固定目标、恢复或补偿路径。每次 reconcile 和 popup 刷新都 fresh read：优先页面播放器公开 getter 返回的有效 `realQ`，否则使用页面播放器或 core 的可解释当前 qn；单个 getter 返回空值、非数字或抛错时记录诊断并继续读备用来源。两边都没有有效 qn 时只显示来源、能力和 `videoWidth`/`videoHeight`，像素尺寸不会冒充精确 qn。手工切换画质触发 core/source/SPA 重建时，点播仍保留同一 BVID/分 P 的 quota、seek epoch 和播放所有权。

产品代码从不设置 `HTMLMediaElement.muted` 或 `volume`，也不替换 Bilibili 原生点播 video/audio source；点播继续观察页面可能分离的原生音视频轨。自动化只为安全测试在 document-start 安装静音守卫，并使用 headless、临时 profile、`--mute-audio`，在每次测试 `play()` 前断言所有 media 为 `muted=true`、`volume=0`。这不是用户可听效果的通过证明。

## 权限、隐私和限制

Manifest 是 MV3，最低 Chrome 版本为 120，没有 service worker、options page、代理、服务器、持久 DVR 或第三种页面模式。内容脚本只匹配 `https://live.bilibili.com/*` 和 `https://www.bilibili.com/video/*` 的顶层页面，并在 `document_start` 执行。

扩展请求 `storage`，以及实现产品 fetch 所需的 `https://api.live.bilibili.com/*` 和 `https://*.bilivideo.com/*`。没有 `tabs`、`activeTab` 或其他额外权限；popup 使用既有 content-script 消息通道读取当前活动页。所有产品请求都使用 `credentials: omit`，没有 Cookie/profile 读取、遥测、分析 SDK、外部字体、远程可执行代码、媒体持久化或全局 fetch/XHR/MediaSource/SourceBuffer 原型 patch。媒体只存在于当前页面的内存 MSE 中。

可用带宽、浏览器编解码器、Bilibili 登录状态、会员/地区授权和官方 CDN 状态都会限制效果。扩展不会承诺超过当前网络带宽，也不会把授权失败伪装成成功。Linux 自动化若缺少 H.264 编解码器，外部直播 smoke 可以是 `BLOCKED`；这不等同于真实 Bilibili 通过。

## 普通 Chrome 手工听音 checkpoint

自动化明确保持静音，下面的可听检查必须由用户在普通 Chrome 中完成，README 不宣称它已经通过：

1. 用目标 Chrome 加载 `dist/extension`，打开一个有权限的点播视频；在 popup 开启“视频增强”，刷新页面，确认声音正常、速度为 2×，并在 popup 观察画质/库存。
2. 打开一个直播间，在 popup 开启“直播增强”，刷新页面，确认直播声音正常、画面和声音持续推进，并观察库存、延迟、画质和倍率。
3. 记录听感和播放行为后，在 popup 对当前页面点击“停用”，再刷新或按页面正常方式播放；比较停用前后的声音连续性、画质和卡顿。不要把自动化的静音结果当作这一步的人工通过。

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

`test:e2e` 使用 Playwright `1.55.1` 的 headless 临时 profile 加载已构建的 `dist/extension`，驱动真实扩展 entrypoint、真实 `LiveController`、Fake `MediaSource`/`SourceBuffer`、受控 API/manifest/segment 路由和 popup。它覆盖点播立即 2×、库存/seek/暂停所有权、只读质量切换与 quota/SPA、桥接能力与 stale session、直播阶段、音频+视频 init、并发同序号恢复、GAP、回到直播、SRI、unsafeWindow/page-world bridge、popup 新鲜度和静音守卫。每次测试结束清理 profile 与临时库。

`test:contract` 检查 MV3、最小 Chrome 版本、精确 match/top-frame/document-start/world、权限、固定 `hls.js@1.5.17`、popup 资源、source/dist 禁止项和生成结果一致性。`smoke:external` 使用匿名、headless、全新临时 profile 访问批准的 VOD URL 和房间 6363772；若房间离线，只从官方推荐列表选择当前 `live_status=1` 的房间。它严格报告 `PASS`、`BLOCKED` 或 `FAIL`，任何 `BLOCKED`/`FAIL` 都以非零退出；反爬、匿名页面没有播放器、网络环境或编解码器缺失只能报告 `BLOCKED`，不能宣称真实页面通过。报告写入被忽略的 `reports/`，不会提交到仓库。

Windows 已安装 Chrome 的加载路径仍是 `E:\workspace\smooth-bilibili-chrome-plugin\dist\extension`；不需要在 Windows 重新 npm/build。不要使用个人 Chrome profile、Cookie、凭据或登录状态运行自动化。
