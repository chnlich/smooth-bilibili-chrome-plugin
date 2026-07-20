# Bilibili 抗卡长期目标

本仓库唯一的产品目标，是让 Bilibili 视频和直播尽量少卡；视频和直播同等重要，不以牺牲其中一类来优化另一类。

## 播放所有权

- 视频页 `/video/*` 和“稍后再看”页使用 Bilibili 原生播放器。每个新的 coherent core/media generation 只向 Bilibili 原生下载器尝试一次 120 秒稳定缓存目标；内核、video 或 source generation 更换后，新的 generation 再独立尝试一次。
- 扩展不下载媒体、不 fetch 媒体、不创建或控制 MSE/SourceBuffer，不替换媒体 source，也不接管播放。Bilibili 和用户继续拥有播放与媒体所有权。popup 只读取当前播放点覆盖的原生 `video.buffered` 连续区间实际秒数；没有覆盖区间就是 0 秒。
- 直播正常立即由 Bilibili 原生播放器开播，不做初始暂停、不主动积累库存、不显示恢复提示或按钮。真实网络卡顿自然形成的延迟，在恢复和换源后尽量保留；扩展不自动追到直播点，也不要求用户操作。
- 播放、暂停、拖动、倍速、画质和音量永远以用户与 Bilibili 的选择为准。直播延迟保护只在首帧之后确认真实网络卡顿时发生，并且只处理媒体位置；绝不读取、写入或拦截 `playbackRate`，不安装全局媒体原型补丁。
- 不引入直播阶段状态机、15/60 秒阈值、45 秒 watchdog、初始缓存暂停、恢复门槛、恢复动作或用户选择流程。可以记录直接观测事实和一次真实卡顿后的窄保护锁存值。
- 只有真实卡顿期间 video 被移除、清空或替换造成区域可能闪黑时，才在页面内存中短暂显示最近成功解码的非黑画面；新 video 首帧后立即撤下，覆盖不改变媒体时间、不阻挡用户控制、不写日志、不写磁盘、不上传，销毁或路由切换时彻底清理。

## 开发诊断日志

开发阶段每次刷新、进入新直播、新视频、新分 P 或新媒体条目建立 session；每个视频和直播页面都记录完整结构化日志。诊断初始化早于功能开关和增强控制器，因此功能关闭、无关支持路由、30 秒没有 video、启动错误、页面内切换以及 video/source/core 替换也会记录。日志只在扩展来源 IndexedDB 追加保存：应用不删除、压缩、摘要、截断、合并、轮转或回收，不设置天数、session 数、单 session 或总容量上限；只受物理磁盘、浏览器资料损坏、卸载和实际存储失败影响。

每条日志先同步镜像到 console，再异步保存；只有 IndexedDB transaction 完成后才标记 `PERSISTED`，存储失败标记 `DEGRADED` 并继续 console，播放永远不等待日志。日志页可以选择当前 session 或全部 session，先固定最大 `eventId`，再用 File System Access 分页、逐行流式导出 JSONL；导出开始后的新增事件继续保存但不进入本次文件。没有上传、遥测或外部日志端点。

日志按固定 event-code family 和字段 allowlist 保存：保留 origin/pathname、房间号、BVID、part、媒体编号、去除 query/hash 的媒体 host/path、媒体事实、扩展动作和安全错误；不保存 query/hash、签名 CDN 参数、Cookie、账号、标题、页面文字、弹幕/聊天、API body、音视频字节、帧或截图。不可直接读取的数值写“未提供”；浏览器报告的数值 0 原样保留并标明浏览器报告。

## 自动化约束

所有 Playwright/Chromium 自动测试都必须使用 fresh temporary profile、Chromium `--mute-audio`，并在 document-start 对所有媒体安装静音 guard；fixture 也不得产生音频。不得使用用户现有 Chrome profile、登录态或可发声窗口。真实页面验证受匿名页面、登录、编解码器或网络环境阻挡时，必须诚实报告 `BLOCKED` 并保留诊断证据。
