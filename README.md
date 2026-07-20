# Bilibili 桌面网页抗卡

这是一个双模式 Manifest V3 Chrome 扩展：直播页使用连续的 HLS/fMP4 缓冲管线，普通视频和“稍后再看”页只给当前 Bilibili 原生播放器一次 120 秒缓存提示。直播与点播是互斥入口，同一个标签页不会同时运行两个控制器。

扩展保留 MV3 外壳、页面桥接、popup、构建流程和全部直播实现。点播增强不接管播放，不自行下载媒体，不创建视频 MSE，也不替换媒体 source。Bilibili 原生下载管线决定实际库存，popup 只读取当前原生 `video.buffered` 中覆盖 `currentTime` 的连续区间。

## 构建和加载

需要 Node.js 20 或更高版本，以及 Chrome/Chromium 120 或更高版本。

```sh
npm ci
npm run build
```

构建结果是已提交的 `dist/extension/`。在 Chrome 地址栏打开 `chrome://extensions`，开启“开发者模式”，点击“加载已解压的扩展程序”，直接选择 `dist/extension`。代码或构建结果更新后，在扩展管理页点击“重新加载”，再刷新已经打开的 Bilibili 页面。

工具栏 popup 是唯一的状态和动作界面。页面本身不会插入状态面板、host、Shadow DOM、徽章或样式。`直播增强` 和 `视频增强` 是下次刷新页面的默认值，不会立即重建当前页面管线；首次安装没有存储值时两项均视为开启。扩展只在 `chrome.storage.local` 保存这两个布尔偏好。

点播 popup 只显示增强偏好、实际连续前向缓存、提示状态（等待、已应用、不支持或失败）和错误消息，不显示画质、速度、下载倍率、延迟、阶段或点播动作。关闭视频增强后，当前页面不会尝试恢复未知的原生目标；刷新后才按偏好决定是否启动点播增强。

## 直播模式

直播从当前直播边缘以 1× 开始，不预先等待 60 秒，不自动追赶、前跳、回到直播、变速、跳过序号或丢弃尚未连续消费的延迟片段。每个必需序号按 init/media 的严格连续顺序进入扩展拥有的 MSE，同一清晰度的 CDN 候选在每一轮并发竞速；暂时性网络错误、超时、5xx 和签名失效会重试同一个序号。停顿后连续前向库存达到 15 秒才恢复，并向约 60 秒积极填充。

popup 会报告 `等待 video`、`配置播放器`、`播放信息`、`manifest`、`MSE`、`init`、`库存形成` 等阶段，以及尝试轮次和脱敏后的候选主机名。直播画质显示 Bilibili 当前的人类可读描述、qn 和 codec。延迟只有在 program-date-time 或连续 MSE 库存与当前清单边缘之间存在有效映射时才显示；没有锚点时显示 `未提供`。下载倍率来自内存中的成功 manifest/init/segment 请求；库存已满时显示 `库存已满`。

零库存的 `STARTING`/`RECOVERING` 代际共用一个绝对 45 秒 watchdog。清单回退、变体/media segment 滑出、精确 codec/profile/session 或 map/init 变化、永久 404、MSE append/remove 错误、队列冻结以及页面夺回媒体 source 都会进入 `GAP_UNRECOVERABLE`；popup 按当前可见性提供“跨过缺口”和“回到直播”。定时器不会自动点击这些动作。直播控制器、恢复水位、累计延迟和用户人工跳转行为保持原有实现。

直播的扩展-owned fMP4 必须同时声明非空 video/audio codec，init segment 也必须同时包含 video/audio track；muxed fMP4 合法，但不会为了补音频而偷偷建立第二条网络管线。缺少音频、组合 codec 不支持或无法形成可解码库存都报告为产品错误/GAP。

## 路由、权限和音频安全

内容脚本只匹配顶层的 `https://live.bilibili.com/*`、`https://www.bilibili.com/video/*` 和 `https://www.bilibili.com/list/watchlater*`。其他 `www.bilibili.com` 路径不启动点播模式。扩展是 MV3，最低 Chrome 版本为 120，没有 service worker、options page、代理、服务器、持久 DVR 或第三种页面模式。

产品代码从不设置媒体的 `muted` 或 `volume`，也不写入播放位置、播放速度、画质或 source。浏览器自动化使用 headless、临时 profile、Chrome `--mute-audio`，并在 document-start 安装静音守卫，在每次 `play()` 前确认所有 video/audio 都是 `muted=true` 且 `volume=0`。自动化静音结果不代表普通 Chrome 的可听效果通过。

扩展请求 `storage`，以及直播产品 fetch 所需的 `https://api.live.bilibili.com/*` 和 `https://*.bilivideo.com/*`。没有 `tabs`、`activeTab` 或其他额外权限；popup 使用既有 content-script 消息通道读取当前活动页。所有产品请求都使用 `credentials: omit`，没有 Cookie/profile 读取、遥测、媒体持久化或全局媒体原型 patch。

## 测试和验证

```sh
npm ci
npm run build
npm run test:unit
npm run test:contract
npm run test:e2e
npm test
npm run smoke:external
```

`test:e2e` 使用 headless Chromium、临时 profile、`--mute-audio` 和 document-start 静音守卫，覆盖一次提示调用、core/media 换代、能力缺失、setter 异常、两种点播路由、无关 www 路径、popup 字段收缩以及完整直播回归。`smoke:external` 使用全新的临时 profile 访问匿名真实点播页，报告实际前向缓存和 120 秒提示状态；短测不宣称长期卡顿率改善。真实直播 smoke 若环境缺少权限、编解码器或网络条件，只报告 `BLOCKED`，不伪装成通过。

不要使用个人 Chrome profile、Cookie、凭据或登录状态运行自动化。
