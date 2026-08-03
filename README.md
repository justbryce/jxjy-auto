# jxjy-auto — 继续教育在线课程自动播放

在**你自己日常用的那个 Chrome** 里，自动、按 1x 真实速度、连续播放继续教育平台的课程视频。
不改进度、不加速、不伪造上报——所有进度上报都由平台页面自己发出，脚本只负责"把视频一个个播起来、播完换下一个"。

已支持三个平台，各自机制完全不同：

| | 平台 | 计时机制 | 需要真播视频？ | 并发限制 |
|---|---|---|---|---|
| 1 | 浙江省工信领域专业技术人员继续教育<br>`engineer.zjsjczx.org.cn` | 每 30s 上报真实 `currentTime`，服务端存 `longesttime` 取最大值 | **必须**，1x 实播 | 无 |
| 2 | 杭州市专业技术人员学习新干线<br>`learning.hzrs.hangzhou.gov.cn` | 每 30~60s 上报一次，服务端按**两次请求之间的真实间隔**加秒 | 不需要（页面开着就计时） | **同一时间只能学一门** |
| 3 | 网易云课堂<br>`study.163.com` | 每 60s 上报真实 `currentTime` | **必须**，1x 实播 | 无，可多课时并行 |

> **写给要接手的 AI agent**：先读 [`AGENTS.md`](AGENTS.md)（`CLAUDE.md` 是它的软链）。
> 那里有上手路径、排错决策树、以及一组"违反了会得到很难查的 bug"的硬规则。

---

## 它能做什么

- **三个平台并行**，每个平台一个独立进程，互不影响，单个崩了不牵连其他。
- **自动选课**：按"每学时耗时最短"排序；先学哪一类由**跨平台缺口**每轮现查决定，不用手配。
- **自愈**：进程挂了自动拉起、卡住自动重开、弹窗自动点掉、登录态失效发系统通知。
- **结果导向的看门狗**：不只看进程活着，还每 30 分钟核对**三个平台上外部可验证的产出**有没有在涨
  （踩过两次"进程活着、日志刷得飞快、真实学时零增长"的坑）。
- **汇总面板**（`http://localhost:8848`）：数字全部现查平台官方接口，标注了每个数字的来源和口径。

## 它不做什么

- 不篡改进度、不倍速、不伪造上报请求。想要 3 分钟刷完 1 小时课程的，这个项目帮不了你。
- 不存任何账号密码——完全复用你 Chrome 里已有的登录态。
- 不替你答题、不替你考试。

---

## 快速开始

### 前置条件

> ⚠️ **只支持 macOS**：用了 `osascript` 管 Chrome 窗口、`caffeinate` 防休眠、BSD 版 `stat`。
> Linux/Windows 上核心播放逻辑能跑，但窗口管理（决定速度的关键部分）要重写。

1. **Node.js 22+**（用到原生 `WebSocket`），零第三方依赖
2. **Chrome 开着远程调试**。两种方式二选一：
   - 地址栏打开 `chrome://inspect/#remote-debugging`，勾选 **"Allow remote debugging for this browser instance"**（可能要重启 Chrome）。**推荐这种**，因为它作用于你日常的 Chrome，登录态都在。
   - 或者命令行启动：`--remote-debugging-port=9222`
3. **在这个 Chrome 里手动登录好你要刷的平台**。脚本不碰登录，登录态过期了会通知你。

### 跑起来

```bash
git clone https://github.com/justbryce/jxjy-auto.git
cd jxjy-auto

./start.sh                  # 一条命令搞定：CDP 代理 + 三个 runner + 汇总面板 + 可见性自愈守护
                            # （已在跑的不会重复启动；代理没跑就自动拉起 tools/cdp-proxy.mjs）
open http://localhost:8848  # 📊 汇总面板，每 60 秒自动刷新（/json 出原始数据）
```

`start.sh` 起不来会明确告诉你卡在哪。想单独跑代理：`node tools/cdp-proxy.mjs`（默认 :3456）。

想让需要真播视频的站点跑满 1x（**强烈建议**，否则只有 30~60% 速度，见「坑 6」）：

```bash
node setup-windows.mjs           # 给每个要真播视频的 tab 各配一个独立 Chrome 小窗口
pkill -f "runners/" && ./start.sh   # 必须真重启：runner 只在启动时读一次 state 里的 tab id
```

⚠️ **一定要 `pkill` 再 `start`**。`./start.sh` 对已经在跑的 runner 是跳过的，
而 tab id 只在进程启动时从 `state/` 读一次、之后全在内存里 ——
不重启的话 runner 还在用它自己建的旧 tab，窗口优化完全没生效，而且你不会收到任何提示。

### 常用命令

```bash
./status.sh                    # 三站进度一眼看完
node hours.mjs                 # 只看学时数字（只读，不影响正在学的课）
node recalc.mjs                # 杭州新干线：手动结算学时（平台每天限 3 次）
node progress-check.mjs        # 核对"真实产出"有没有在涨
tail -f logs/hzrs.log          # 看某个站的实时日志
./start.sh hzrs                # 只启动某一个
node heal-visibility.mjs --dry # 查专用 tab 还是不是 visible（只报告不动手）
pkill -f "runners/hzrs.mjs"    # 停某一个（⚠️ 5 分钟内会被 watchdog 拉起来）
./pause.sh                     # 全停，并让 watchdog 别再拉起 —— 维护/重新登录时用这个
./pause.sh off                 # 解除暂停并立刻启动
```

### 挂上定时任务（可选但建议）

```cron
*/5  * * * *  /绝对路径/jxjy-auto/watchdog.sh        # 进程死活 + 卡死重启 + 日志轮转
*/30 * * * *  /绝对路径/jxjy-auto/progress-check.sh  # 真实产出有没有在涨
5 8,20 * * *  /绝对路径/jxjy-auto/recalc.sh          # 新干线学时结算（平台限 3 次/天）
```

> ⚠️ **cron 只做"守护"，不做"自愈"。** 可见性自愈守护进程只由 `./start.sh` 拉起 ——
> watchdog 发现它不在会告警（`logs/ALERT.log` + 系统通知），但**不会替你启动它**。
> 所以开机后、或用 `./pause.sh` 停过之后，都要在终端跑一次 `./start.sh`。

---

## 配置

全部通过环境变量。想固化到本机又不进 git，就写进 `env.local`（已在 `.gitignore` 里，`start.sh` 会自动 source）：

```bash
echo 'export EXPOSE=lan' >> env.local        # 让手机/局域网也能看面板
echo 'export NC_CONCURRENCY=2' >> env.local
```

| 变量 | 默认 | 说明 |
|---|---|---|
| `CDP_PROXY` | `http://localhost:3456` | CDP 代理地址 |
| `NC_CONCURRENCY` | `3` | 网易云课堂并行 worker 数。**改了要重跑 `node setup-windows.mjs` 并重启 runner**。实测 10 路仍是满速（见坑 6）|
| `HZ_PLAY_VIDEO` | `0` | 新干线要不要真的播视频。它的学时按页面墙钟计，播视频对学时零收益却抢带宽，所以默认关 |
| `NC_VOLUME` | `0` | 网易云播放音量。**只能是 0 或很小的值**，且绝不能改成 `muted=true`（见坑 2） |
| `EXPOSE` | 空 | 面板监听范围。默认只绑 `127.0.0.1`；`lan` = 额外绑内网地址（手机能看，**但无鉴权**）；也可填具体 IP |
| `PORT` | `8848` / `3456` | 面板端口 / CDP 代理端口。⚠️ **三个**程序都读它：dashboard、cdp-proxy，
以及 hzrs runner（用它拼面板地址取跨平台缺口）。写进 `env.local` 会同时影响 dashboard 和 hzrs |
| `CHROME_PORT` | `9222` | Chrome 远程调试端口（`tools/cdp-proxy.mjs` 用，会自动探测 9222/9229/9333） |
| `SCREEN_W` | 读 system_profiler | 排窗口用的桌面宽度。⚠️ 自动探测**只会把各屏宽度加起来**，看不出方位（见坑 6g），多屏时建议手工指定 |
| `SCREEN_X0` | `0` | 排窗口用的最左边界。副屏在左边时是负数（如 `-1080`）|
| `ZJ_X` | 贴右边缘 | 浙江工信窗口的左边界。显式指定可以把它单独摆到**另一块屏**上 |
| `WIN_STEPY` | `0` | 层叠窗口的 y 步长。`0` = 纯水平层叠（z 序一变可能被夹死）；**多屏/窄屏务必设成 60 左右走对角线**（见坑 6e）|
| `OSA_TIMEOUT_MS` | `90000` | osascript 超时。并发高时 Chrome 建窗口会变慢，别调小 |
| `HEAL_COOLDOWN_MIN` | `30` | 两次可见性自愈之间的**基础**冷却。自愈没治好时会在此之上指数退避 |
| `HEAL_RATE_OK` | `85` | 近期播放速率中位数 ≥ 这个值就**绝不自愈**，不管 tab 是不是 hidden（见坑 6d）|
| `HEAL_BACKOFF_MAX_MIN` | `240` | 自愈退避的冷却上限 |
| `STALE_MIN` | `90` | 产出多少分钟没涨就告警 |
| `GOAL_SPEC` | `180` | 跨平台**专业**学时总目标（面板汇总 + 新干线调度都读它）|
| `GOAL_GX` | `90` | 跨平台**公需**学时总目标 |
| `HZ_FIELD_ID` | `9` | 新干线专业领域断言（**≠ 学科门类**）。9=工业和信息化领域系列，空串=关掉校验 |
| `NC_SKIP_AFTER` | `3` | 网易云某课时连续失败几次才永久跳过。**别设 1** —— 环境临时坏会成批误杀 |
| `WIN_WIDTH` | `1100` | 浙江工信窗口宽度。太窄站点会切窄屏布局、导航菜单压住 `<video>`（见坑 7b）|
| `WIN_BOTTOM` | `1000` | 专用窗口底边 y。太矮视口装不下播放器，合成点击会飞出去（见坑 7b）|
| `HEAL_INTERVAL_SEC` | `300` | 可见性自愈守护的自查间隔 |
| `PANEL_TIMEOUT_MS` | `20000` | 面板**单个平台**的取数超时。超时只显示该平台错误，不拖垮整页 |

需要手配的只剩一个「专业领域断言」，走环境变量（也可写进 `env.local`）：

```js
// runners/hzrs.mjs —— 唯一还需要按人调整的常量
const FIELD_ID = process.env.HZ_FIELD_ID ?? '9';   // 专业领域：9=工业和信息化领域系列
```

新干线**先学哪一类、学哪个方向，都不用手配**：
- 方向：`SelectCourse` 返回的课程池**服务端已经按账号申报的专业领域过滤过了**，
  客户端不需要再按学科门类筛（按「工学」筛反而会误杀同样合格的经济学/理学课）。
  `FIELD_ID` 只是选课前的一道断言，方向不对就跳过并告警。
- 顺序：runner 每轮问汇总面板要**跨平台缺口**（三个平台加起来还差多少专业/公需），
  谁缺补谁；问不到就退回本站自己的年度要求。

跨平台总目标用 `GOAL_SPEC`（默认 180）和 `GOAL_GX`（默认 90）配。

---

## 目录结构

```
start.sh / status.sh          启动、看状态
setup-windows.mjs             🔑 给要真播视频的 tab 各配一个独立可见 Chrome 窗口（决定速度）
dashboard.mjs                 汇总面板 HTTP 服务（:8848）
hours.mjs                     只读进度汇总（命令行版）
recalc.mjs / recalc.sh        杭州新干线学时结算
progress-check.mjs / .sh      结果导向看门狗
heal-visibility.mjs           锁屏掉可见性时重建窗口+重启 runner；由 start.sh 以 --daemon 常驻拉起
pause.sh                      维护开关：全停 + 让 watchdog 别拉起（./pause.sh off 恢复）
watchdog.sh                   进程看门狗（cron）
lib/cdp.mjs                   CDP 客户端 + 可见性/窗口工具 + 状态持久化
runners/zjsjczx.mjs           浙江工信
runners/hzrs.mjs              杭州新干线
runners/study163.mjs          网易云课堂
tools/cdp-proxy.mjs           自带的最小 CDP 代理（start.sh 会在没有现成代理时自动拉起）
AGENTS.md / CLAUDE.md         给 AI agent 的上手指南（后者是前者的软链）
LICENSE / package.json        MIT；package.json 里有 npm start/status/hours/windows/proxy 几个快捷脚本
state/                        运行状态（tab id、黑名单、跳过的课时…）
logs/                         日志 + 异常截图
```

---

## 平台机制速查

### 浙江工信 `engineer.zjsjczx.org.cn`
- jeecg-boot + Vue，后端前缀 `/jeecg-boot/`，鉴权头 `X-Access-Token`。
  token 在 localStorage 键 `JEECGBOOT_PRO__PRODUCTION__3.8.3__COMMON__LOCAL__KEY__` → `.value.TOKEN__.value`，有效期 7 天。
- 课件列表 `GET /jeecg-boot/zg/student/courseware/list?pageNo=1&pageSize=500&zgcZglType=N`
  （N=1 专业科目 / 2 一般公需 / 3 行业公需），字段 `zgcId,title,length(秒),longesttime,progress,classtime`。
- 学时汇总 `GET /jeecg-boot/zg/apply/myHours?year=2026` → `genclasstime`/`indclasstime`（**都是字符串**）。
- 播放页 `/zg/student/video-player?id=<zgcId>`，原生 `<video>`（容器 `.video-container`）。
  部分课件的 src 是后端签发的 `/jeecg-boot/zg/courseware/video/play?coursewareId=..&token=..`，要等几秒才有。

### 杭州新干线 `learning.hzrs.hangzhou.gov.cn`
- 全部 `POST /api/index/...`，同源 fetch 带 cookie，无需额外 header。
  - 目录 `/api/index/index/SelectCourse` body `{limit,page,type}`
    —— **筛选参数叫 `type` 不是 `typeid`**（传 `typeid` 会被静默忽略，返回全量 8000+ 门）。
    type：15 专业课程 / 16 行业公需 / 17 一般公需。
  - 选课 `/api/index/Course/chooseCourse` body `{courseid:["..."]}`（可批量）
  - 我的课程 `/api/index/Course/index` body `{limit,page}`，`validstudytime`(已计秒) / `coursetimes`(需要秒)
  - 学时后台 `/api/index/Study.UserIndex/index` body `{}`
  - 计时 `/api/index/Study.Index/updateStudy` body `{courseId,delay,logId,sign}`（`sign` 是滚动令牌，页面自己维护）
- **学完不会自动结算学时**，必须去后台点「学时重算」，**每天限 3 次**（`recalc.mjs` 干这个）。

### 网易云课堂 `study.163.com`
- 我的课程 `GET /j/my/courseListV2.json?pageSize=20&pageIndex=N&keyword=&filterType=0&t=<ts>`
  —— **必须带请求头 `edu-script-token`，值取 cookie `NTESSTUDYSI`**，否则 403（空 body，很难排查）。
- 学习页 `courseLearn.htm?courseId=X#/learn/video?lessonId=Y&courseId=X`
- 课时目录 DOM：`.m-chapterList .section[data-id=<lessonId>]`，
  `.ksname` 名称 / `.ksicon` 的 `title` 是状态（已完成/进行中/未开始）/ `.ksinfo` 是 `mm:ss` 时长。
- 播放器走 HLS/MSE（`video.src` 是 `blob:`）。**同一门课的不同课时可以在不同 tab 里并行播**。

---

## ⚠️ 踩过的坑（全部是实测，值钱的部分在这）

**1. Chrome 窗口被完全遮挡时，所有 tab 都是 `hidden`，隐藏 tab 里原生 `<video src=*.mp4>` 一秒都不加载。**
卡在 `networkState=2 / readyState=0` 永远不动，而同一个 URL 用 curl 拉飞快——极容易误判成网络/代理问题。
解法：`/front` 让 tab 可见 3~4 秒把加载踢起来，之后转后台能持续 1x 播放。

**2. `video.muted = true` 会被 Chrome 在 play 后约 6ms 立刻暂停**（后台静音视频优化）。
要静音必须 `volume = 0` + `muted = false`。

**3. 绝对不要在 CDP eval 里 `await video.play()`。**
视频加载不动时那个 Promise 永远不 settle，`Runtime.evaluate` 会挂到超时（45s）才抛异常，直接把进程带崩。
一律 fire-and-forget：`const p = v.play(); p && p.catch(()=>{})`，sleep 几秒后再单独读 `paused/readyState`。

**4. 别自己开裸 CDP 连接**（`ws://127.0.0.1:9222/devtools/browser`）。
会触发 Chrome 的调试授权弹窗，而且**Chrome 同一时间只允许一个 browser 级调试连接**——
已经有别的工具连着时，你的连接会直接超时。统一走一个常驻代理。

**5. 🔥 "静默空转"：进程活着、日志刷得飞快、CPU 也在忙，但真实学时零增长。踩过四次。**
- 新干线会对**早已拿过学分、又被重新选课**的课程秒判 `finish=1` → 同一门课 60 秒一轮无限重开。
  （根因：`Study.UserIndex/index` 的已学课程列表**只返回 8 条**，不是全量，所以不知道它已经拿过学分。）
- 网易云播完后读的目录是**开播之前**加载的旧快照，永远显示未完成 → 同一课时反复重播。
- 🔴 **"完成"的判据挑错了一个**：上面那种秒判完成的课，平台**同样会把它移出「我的网络课程」**。
  于是"课程从我的网络课程里消失了"这个看似铁证的信号，把空转记成了成功——日志里全是 ✅，
  学时一点没涨，实测这样跑了一个半小时（2026-08-03）。
  **判据必须是时间**：`用时 < 该课应需时长的一半` → 一定是早就拿过学分，直接拉黑。
  写完成判定时先问自己：**这个信号在"失败"的情况下会不会也出现？**

- **登录态失效但接口返回 `HTTP 200 + {code:-2,"not_auth"}`** → 拿到空列表，脚本以为"没课可学"，
  而视频照常播（CDN 不校验登录）。实测这样白播了 88 分钟，平台计入的课时只涨了 1。

  **教训：跑批自动化必须定期核对"外部真实产出"是否在涨，光看日志在动完全不够。**
  这就是 `progress-check.mjs` 存在的理由。

**5b. 🔴 别用一次性的失败做永久决定 —— 这个项目为此栽了三次。**
"这门课/这个课时学不了" 落盘之后就再也不会重试，而真实原因往往只是**环境临时坏了**
（登录态掉线、Chrome 抽风、页面没渲染完、窗口太小导致点击点飞）。环境一坏就**成批**误杀：

| 站点 | 误判的信号 | 后果 |
|---|---|---|
| 新干线 | "课程从我的网络课程消失了" = 学完了 | 空转的课也会消失 → 日志全是 ✅ 学时不涨 |
| 浙江工信 | "起播 5 次都失败" = 课件源坏了 | 20 分钟误杀 9 门正常的课 |
| 网易云 | "watch() 返回 skip/timeout" = 这课时不是视频 | 一口气废掉 86 个课时，整门课全军覆没 |

**永久决定要配永久证据。** 分得清就分开走分支（`NotSupportedError` = 源坏了，
`{none:true}` = 页面没加载好）；分不清就**连续失败 N 次**才落盘（成功即清零），
或者只在本进程内软跳过、重启即失效。

**6. 🔥 `document.visibilityState` 是按「窗口」算的：一个窗口里只有当前 tab 是 visible。**
所有要真播视频的 tab 挤在同一个窗口时，永远只有一个能跑满，抢 `/front` 是零和游戏。
hidden 页面会被 Chrome「密集节流」（定时器降到约 1 次/分钟），掐死 hls.js 的分片加载循环
→ 速率掉到 30~60%，而且**缓冲区出现断层但网络其实几毫秒就返回**，极具迷惑性。

**解法：给每个要真播视频的 tab 各配一个独立 Chrome 窗口**（`setup-windows.mjs`）。
又因为 macOS 的遮挡判定只在**完全**被盖住时才成立，把小窗口顶边放在 **y=25**（主窗口一般从 y≈122 起），
即使主窗口被抬到最上层，小窗口顶部那条仍然露着 → 依旧 visible。

实测吞吐对比（同一台机器 M4 mini / 1920×1080，网易云课堂）：

| 配置 | 每路速率 | 合计吞吐 |
|---|---|---|
| 3 个 tab 挤在一个窗口 | 21% | 0.63x |
| 2 个 tab 挤在一个窗口 | 100% / 44% | 0.62x |
| 1 个 tab | 33~45% | 0.45x |
| 3 个 tab 各自独立窗口 | 100% ×3 | 3.00x |
| 6 个 tab 各自独立窗口 | 100% ×6 | 6.00x |
| **10 个 tab 各自独立窗口** | **99~100% ×10** | **10.00x**（CPU 仍有 63% 空闲） |

**窗口要层叠排，不能并排。** Chrome 有约 400px 的最小窗口宽度，你把 bounds 设得更窄
它会自己拉宽 —— 并排的话 1920 宽最多摆 4 个，第 5 个开始就会把前面的完全盖死。
而遮挡判定只在**完全**被盖住时才成立，所以每个窗口只要露出一条边就够：
按 `(屏宽-400)/N` 的步长层叠，每个露出「步长 × 97」的一条（主窗口从 y≈122 起，上面那条一直露着）。
10 路时步长 138px，照样全部 `visible`。

试过但**行不通**的路子（省得你再试一遍）：
- `volume > 0` 让 Chrome 认为"页面在发声"从而豁免节流 → 有声播放需要 user activation，
  而 CDP 的合成点击拿不到（`navigator.userActivation.hasBeenActive` 恒 false，`/front` 之后也一样），
  `play()` 一直抛 `NotAllowedError`。
- `Emulation.setPageVisibilityOverride` → 新版 Chrome 已移除；
  `Page.setWebLifecycleState('active')` 能调通但改不了 `document.hidden`。

**6b. ⚠️ 加并发之后一定要盯真实产出。**
曾经把网易云从"实际 0.6 路"提到"3 路满速"后约 15 分钟，接口开始返回
`HTTP 200 + {code:-2,"not_auth"}`——**登录态被判失效，但视频照常播**（CDN 不校验登录），
又是一次静默空转。当时归因成"账号共享风控"，但**后来 6 路、10 路各跑了十几分钟都没再复现**，
所以那次多半是巧合或别的原因，别把它当成硬上限。

真正的结论是方法论上的：**并发是你唯一能改、又最容易骗自己的旋钮。**
加完之后必须看 `progress-check.mjs` 的外部产出有没有同步涨，
而不是看日志里有几个 worker 在滚。

**6c. 🔒 锁屏会让已有窗口全部退回 hidden —— 但新建的窗口不会。**

macOS **在锁屏那一刻把当时存在的所有窗口标成 occluded，之后在锁屏期间不再重新计算**。
于是摆好的专用窗口全部变 `hidden`，速率掉下来。实测影响不均：
- 网易云（hls.js 靠 JS 定时器拉分片）掉到 **37~84%**
- 浙江工信（原生 `<video src=*.mp4>`）**不受影响，仍是 100%** ——
  已经在播的媒体元素不吃定时器节流，被掐死的只是"用 JS 驱动加载"的那类播放器

**解法：锁屏之后新建的窗口是 `visible` 的，而且完全不被节流。**
实测在锁屏 + 显示器休眠状态下新建窗口，`setInterval` 161 秒整整跑了 161 次（1.000/s），
`requestAnimationFrame` 也是满帧。所以**重建一次窗口布局就能恢复满速**，
不用重启 Chrome、不用改锁屏设置、不用加 `--disable-background-timer-throttling` 之类的启动参数。

这件事已经自动化：`heal-visibility.mjs` 由 **`./start.sh` 以 `--daemon` 常驻拉起**，
每 5 分钟（`HEAL_INTERVAL_SEC`）查一次专用 tab 的 `visibilityState`，发现变 hidden
**且真的在掉速**才重建窗口 + 重启 runner，冷却 30 分钟（`HEAL_COOLDOWN_MIN`）+ 指数退避。
「且真的在掉速」这个条件是后来加的，为什么加见下面 6d —— 那是这个项目最贵的一次教训。
⚠️ **watchdog.sh 只负责"这个守护进程死了就告警"，不自己做自愈** ——
只挂 cron 而从没跑过 `./start.sh` 的话，自愈永远不会发生，症状是"默默慢 3 倍"。
屏幕解锁时它是 no-op，所以本地用的人不用管它。

试过但**没用**的（省得再试）：把窗口挪回 y=25（macOS 不会因为窗口移动就重算遮挡）、
`caffeinate -u -t N` 唤显示器（锁屏时唤不动）、`sudo pmset -a displaysleep 0`
（断开屏幕共享时 macOS 会直接把显示器睡掉，绕不过）。

判断是不是锁屏了：所有 tab 的 `document.visibilityState` 全是 `hidden`，
而 `osascript` 查到的前台 app 明明就是 Chrome。

**6d. 🔥🔥 自愈本身成了最大的故障源：15 小时零产出。这是本项目单次代价最高的 bug。**

症状：网易云从早上 10:29 到次日凌晨 1 点，**一个课时都没完成**，而日志一直在滚、速率一直是 100%。

因果链，每一环单看都"合理"：

1. 用户的终端在主屏最大化 → Chrome 所有窗口被完全遮挡 → 11/11 个专用 tab `visibilityState=hidden`。
2. `heal-visibility` 看到全 hidden，判定"锁屏了"（见 6c），重建窗口 + **`pkill runners && ./start.sh`**。
3. 重建出来的窗口还是在主屏，几分钟后又被终端盖住 → 回到第 1 步。**每 ~11 分钟一轮，一天 42 次。**
4. 网易云**不认断点续播**（坑 11），每次重启都从 `currentTime=0` 重来。
   而队列里全是 30~90 分钟的长课时 —— **一个都熬不到下一次重启。**
   《比特币：共识协议》(87:33) 被重开 **36 次**，累计播了约 6 小时，得到 **0 学时**。

三个各自独立的教训：

- **🔴 `visibilityState` 不是伤害信号，掉速才是。**
  Chrome 的密集节流**只拦"起播"，拦不住已经在播的媒体元素**（这在 6c 里其实已经写了，
  只是当时只把它当成"浙江工信不受影响"的注脚，没意识到它同样适用于已起播的 163）。
  所以「全 hidden + 速率 100%」是完全正常的稳态，此时自愈是**纯亏损**。
  现在 `heal-visibility` 先读 `logs/study163.log` 里近期 `速率xx%` 的中位数，
  ≥85% 就绝不动手，不管 visibility 是什么。

- **🔴 修不好的东西，重试要指数退避。** 原来的 8 分钟固定冷却，在"病因根本不是锁屏"时
  就变成了每 8 分钟自残一次。现在连续 N 轮修完症状还在 → 冷却翻倍（30 → 60 → … → 240 分钟），
  症状消失则清零。**任何"自动修复"都要能识别出自己没修好，并且越修不好越少动手。**

- **🔴 自愈动作的代价必须算进触发阈值。** 这里一次自愈 = 丢掉 10 路正在播的进度。
  代价越大，触发条件就要越保守。原来的设计默认"重建窗口几乎不要钱"，
  在长视频场景下这个假设是灾难性的。

**6e. 只错开 x 的层叠**不保证**可见 —— 必须走对角线。**
`Chrome` 最小窗口宽 400px，副屏只有 1080px 宽，10 个窗口的步长只有 61px。
这时任何一个中间窗口都可能被「左边那个 + 右边那个」的并集完全盖死，
**盖不盖得住只取决于 z 序**，而 z 序会被 runner 的 activate、用户点窗口随时打乱。
实测建完全是 `visible`，几分钟后 10 个里有 4 个变 hidden，位置一点没动。

改成 x 和 y **同时**递增就和 z 序无关了，几何上可证：窗口 i 右上角那块 `STEPX × STEPY` 的小矩形，
编号更大的窗口都在它右下方（够不着），编号更小的窗口右边缘 `x_i + CW - STEPX` 在它左边（也够不着）。
macOS 的遮挡判定要求**完全**覆盖，所以那一小块永远救着它。代价是要有竖向空间。
用 `WIN_STEPY` 打开（0 = 老的纯水平层叠）。

**6f. 副屏上没有菜单栏，`y=25` 不会被夹成 `30`。**
`setup-windows.mjs` 靠"顶边读回值"这个几何签名回收上一轮的旧窗口。
主屏上 Chrome 会把 `y=25` 夹到菜单栏下沿 `30`，副屏上则原样返回 `25` ——
签名对不上就一个都回收不掉，一晚上攒到 26 个窗口，而它们互相遮挡又会触发 6d 那个自愈循环。
**任何跨屏的窗口几何签名都要把两种读回值都算进去。**

**6g. 副屏在左边时坐标是负的，而 `system_profiler` 看不出方位。**
它只给每块屏的分辨率，不给排列。代码把 `2560 + 1080` 当成"右边接了一块"，
于是把窗口摆到 `x=2560..3640` —— 那是块死区，窗口建出来直接就是 `hidden`。
**探测方位的可靠办法是建个测试窗口、设成负坐标、再把 `bounds` 读回来**：
读回值不变就说明那块区域真实存在。这台机器实测副屏在 `x=-1080..0`。
或者干脆用 `SCREEN_X0` / `SCREEN_W` 手工指定，别猜。

**6h. 🔥🔥 提速和并发不能同时拉满：整台机器被刷爆内存，Chrome 主进程死锁。**

11b 那个「短课时优先」把网易云的完成速度从 6 课时/小时提到了 110 —— 但它同时把
**页面切换频率提高了 18 倍**。10 个 hls.js 播放器的缓冲 + 不停重建的渲染进程，
在一台 16G 的 mini 上（还开着用户自己的一堆 App）把内存彻底榨干：
可用物理内存剩 ~105MB、6G swap 用掉 4.9G，macOS 弹出「系统的应用程序内存不足」。

**Chrome 浏览器主进程随即死锁**，症状很有辨识度，值得记住：

| 现象 | 说明 |
|---|---|
| `curl :9222/json/list` 超时 | 这个端点由**浏览器主进程**服务 |
| 该进程 CPU **0%**，但 `sample` 显示主线程栈 100% 停在同一处（最内层 `_sigtramp`） | 不是忙，是**卡死在信号处理器里**——等于已经崩了，崩溃处理器又没走完 |
| `System Events` 查它 **0 个窗口** | AX 层也僵了 |
| 杀掉那几个 100% CPU 的渲染进程**没用** | 病根在浏览器进程，不在渲染进程 |

**教训：吞吐优化必须连着资源上限一起评估。** 一个"纯赢"的调度改动，
在换算成"单位时间的页面切换次数"之后可能是资源消耗的数量级增长。
现在并发从 10 降到 5（吞吐仍有 ~55 课时/小时，是优化前的 9 倍）。

**6i. 🔴 Chrome 的远程调试授权是「按浏览器实例」给的，而且程序点不掉。**

Chrome 136+ 用默认 profile 时，远程调试**只能**靠 `chrome://inspect/#remote-debugging`
的勾选框开启（`--remote-debugging-port` 命令行参数在默认 profile 下被**直接忽略**，
端口根本不监听 —— 这是防 cookie 窃取的安全措施）。
勾选状态确实持久化在 `Local State` 的 `devtools.remote_debugging.user-enabled`，
但**每个浏览器实例仍然要人再确认一次**：有客户端连调试端口时，Chrome 弹
「要允许远程调试吗？」，在人点「允许」之前 TCP 连上了也不做 WebSocket 握手。

**所以：Chrome 一崩溃/重启，自动化就断，且只能人工恢复。** 实测点不动的手段（全试过）：

- `System Events` 的 `click at {x,y}` / `key code`（回车、Esc）
- CoreGraphics `CGEventPost(kCGHIDEventTap, ...)`，事件源分别用 private 和 `kCGEventSourceStateHIDSystemState`

同样这套 CGEvent **能**点掉 Chrome 别的 UI（实测点掉了「要恢复页面吗？」气泡的 ×），
所以不是权限问题、也不是坐标问题（截图带光标验证过指针就压在「允许」上）——
**是 Chrome 对这个安全对话框专门屏蔽了合成输入。**

⚠️ 附带的坑：**每一次连接尝试都会新弹一个授权框。** 自动重连脚本探得太勤会堆一叠，
人点掉一个后面立刻又顶上来一个，看起来就像"点了没用"。重连探测间隔要放到分钟级。

**6j. TCC 授权按「责任进程」给，而 Claude Code 起的 shell 会被算成 `node`。**

这台机器上 `/opt/homebrew/.../node` 在辅助功能里是 **`auth_value=0`（永久拒绝）**，
多半是某次锁屏时授权弹窗没人点被静默记成了拒绝。后果：从 Claude 的 bash 里跑
`osascript` 发合成点击/按键，**静默失效** —— 不报错、没反应，极难查。

查授权表：
```bash
sqlite3 "/Library/Application Support/com.apple.TCC/TCC.db" \
  "select client,auth_value from access where service='kTCCServiceAccessibility'"
```

绕法（按代价从低到高）：
1. **从 tmux 里派发**（`tmux new-window -d "bash your.sh"`）—— tmux server 的责任进程是终端 App
   （这台机器上是 Ghostty，`auth_value=2`），**不弹任何窗、直接就有权限**。最省事，首选。
2. `ssh localhost` 借 sshd 的授权 —— 需要公钥登录，而且会触发 sshd 自己的 TCC 弹窗。
3. `open -a Terminal your.sh` —— Terminal 虽然也有辅助功能授权，但会触发
   「"终端"想要控制"System Events"」的 Automation 弹窗，**而那个弹窗同样没人点**，直接卡死。

**7. 🔴 认"我刚建的那个 tab"，差集**不够**，必须再用 host 复核。**
新建 tab 会被 Chrome 扔进位置随机的新窗口，经常正好压住那几个必须保持可见的小窗口 ——
不需要可见的 tab（比如新干线的课程页）要主动挪走：`cdp.parkWindow()`。

认新 tab 有两个都会踩的坑：
- 按 **URL 找** → 命中别处早就存在的同址老 tab。
- 按 **targetId 差集** → 你共用的是用户日常的 Chrome，**里面还跑着别人的自动化**，
  它们也会在你建窗口的那几秒里开 tab。实测就把「浙江工信」的 target
  写成了另一个项目（抢票监控）的 tab —— runner 一跑就会把人家的页面导航走。

正确做法是**两个条件都要满足**：既是新出现的 target，host 又对得上。
一个都对不上就宁可跳过，绝不"取第一个"。共用浏览器的项目里，这是最该防的一类事故。

**7b. 窗口的宽和高都要够，而且宽度**按站点分别给**。**
- **高度不够** → 页面视口装不下播放器，`<video>` 中心落在视口外，
  CDP 的合成点击被派发到视口边缘，点到顶部导航栏，把页面带去别的路由。
- **宽度不够** → 站点切换成窄屏/移动布局，左侧导航菜单直接压在 `<video>` 上面，
  点击同样落到菜单项上。**表现完全像"课件坏了"**，实际是布局问题（排查了很久）。
- **但也别一刀切给宽**：10 个 1100px 宽的窗口同时渲染视频，能把 Chrome 压到
  **连 AppleEvent 都超时**（`tell application "Google Chrome"` 全线 -1712，
  而同一时刻 CDP 完全正常）。渲染面积是有成本的，只给需要的那个站点。

所以：串行的站点（一次只播一个）给正常大小窗口，并行的那些才用最小宽度层叠。

**7c. 合成点击之前，先确认"点击点确实落在你要点的东西上"。**
`elementFromPoint(cx,cy)` 校验一下，判据用"**在播放器容器内**"而不是"必须正好是 `<video>`"
（播放器普遍会盖一层透明控制层，抠太死永远判不过）。点完再复核 URL 有没有变，变了就退回去。
拿不到用户手势没关系 —— `volume=0` 播放本来就不需要手势，**硬点的代价远大于收益**。

**8. 新干线：有历史进度的课一打开就弹「是否继续学习？」，不点掉计时器根本不启动**
（`updateStudy` 一次都不发、`playTime` 恒为 null，页面看起来完全正常）。
完成时弹的是「您的学习时间已达到要求，获得学分:X…」，那个**别点确定**（会重新开始学同一门）。
另外「学时重算」按钮只吃 JS 的 `el.click()`，真实鼠标 `clickAt` 点不出确认弹窗（顶部固定头挡着）。

**9. 新干线：`updateStudy` 返回的 `playTime` 是「本次会话」秒数**（每次开页面新建 `logId` 从 0 起），
累计值要看 `validstudytime`。判"有没有在推进"用 `playTime`，判"完成没有"用「已计 + 本次」。
`validstudytime` 对**真在推进**的课是实时的（实测 735 → 909），但对**被重新选课**的课会重置成 0，
所以它不能用来判"这门课以前是不是已经学完过"。

**9b. 🔴 新干线的学时数字，唯一可信的来源是 `Study.UserIndex/index` 的 `data.study`。**
同一个响应里的 `data.course`（已学课程列表）**只返回最近 8 条，传 `limit`/`page` 也没用**——
拿它加总估学时，数字会永远卡在 `8 × 0.5 = 4.0`（踩过，据此做的调度判断整整一个半小时没往前走）。
`data.study` 是平台自己算好的每类 `r`=年度要求 / `s`=已获得 / `w`=还差，例如：

```json
[{"coursetype":"专业课程","r":"60.0","s":"11.0"}, {"coursetype":"行业公需","r":"0.0","s":"5.0"},
 {"coursetype":"一般公需","r":"0.0","s":"0.0"}, {"coursetype":"总学时","r":"90.0","s":"16.0"}]
```

**先学哪一类要现查这个，别硬编码**——不同账号的要求不一样（这个账号公需的要求其实是 0，
只是没有下限、仍然计入总学时 90；按传闻的"公需≥18"去排序就把顺序排反了）。
注意 `s` **只在点过「学时重算」之后才更新**，两次重算之间要自己记未结算的增量。

**10. 新干线：没选过课的课程，详情页点「立即学习」毫无反应**（不报错、不弹窗、不发请求）。必须先 `chooseCourse`。

**11. 网易云：会断点续播，而从断点播到结尾服务端不判完成**（它按看过的区段算）。
必须 `currentTime = 0` 从头播。另外**切课时后 `<video>` 可能还是上一课时的残留**
（`currentTime` 已接近 `duration`），会被误判成"已播完"直接跳过——切课后要等 `duration` 和目录里的 `mm:ss` 对上。

**11b. 🔴 上一条的推论：课时时长 = 暴露在中断风险下的时间 → 队列必须短课时优先。**
既然一个课时必须**一口气**播完才算数，那中途任何一次重启（自愈 / 看门狗 / 崩溃 / 登录态掉线）
都会让这一整段白播。于是"学一个 87 分钟的课时"和"学 87 个 1 分钟的课时"在期望产出上差得极远：
后者每完成一个就落袋为安，前者只要在 87 分钟里被打断一次就归零。
实测（2026-08-04）改成按时长升序排队之后，同样 10 路并发，产出从 **6 课时/小时 → 110 课时/小时**。

⚠️ 排序时**没有时长的课时要排最后，不是最前**。163 里没时长的几乎全是作业/考试/资料链接，
根本没有 `<video>`。第一版把它们当 0 秒排到了最前，结果 10 个 worker 一开局全去啃空课时，
白白烧掉"连续失败计数"（见坑 5b）。

**11c. 假警报比没有警报更糟。**
`progress-check.mjs` 原来盯的新干线指标是 `data.course.length`（已学完门数），
而那个列表被平台截断到 8 条（坑 5、坑 9b）——**它是个死指标，学多少都返回 8**。
于是它从中午一直报警到凌晨、刷了 20 多条，同期新干线的学时其实从 16 涨到了 49。
真正的问题（网易云 15 小时零产出）就淹在这些噪音里，没人看得见。
**指标上线前先问它的上限/边界是什么**，并且不同指标要给不同的"多久没涨才算不正常"窗口
——新干线只在「学时重算」后跳（一天 2~3 次），用 90 分钟去卡它必然天天误报。

**12. 网易云：找弹窗别用 `[class*=layer]` 这类宽松选择器**——播放器控制条也带 `layer`，
会把「10:09 / 14:35 1x 标清」误报成弹窗。要加 `position:fixed/absolute` + `z-index>=10` + 不含 `<video>` 的过滤。

---

## 想加一个新平台？

照着 `runners/` 里现成的三个抄，一个 runner 就是一个独立进程。核心是先搞清楚三件事：

1. **平台靠什么计时？** 真实 `currentTime`、页面墙钟、还是别的？
   → 决定了要不要真播视频、要不要抢"可见性"。
   查法：在播放页装个 XHR 钩子，看它每隔多久往哪个接口发什么。
2. **完成的判据是什么？** 哪个字段、什么时候更新、是不是实时的？
   → 决定了怎么判"这门课学完了"、怎么防无限重播。
3. **有没有并发限制？** 同时开两门会不会被踢？
   → 决定了串行还是并行。

然后：`start.sh` 里加一行、`dashboard.mjs` 里加一个取数函数、`progress-check.mjs` 里加一个指标。

---

## 免责声明

这个工具做的事等价于"把浏览器挂在那里按正常速度播视频"，不修改任何进度数据。
是否符合你所在平台的使用条款、以及由此产生的一切后果，请自行判断和承担。
