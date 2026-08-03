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
- **自动选课**：按"每学时耗时最短"排序，可配置学科门类优先级和各类别的目标学时。
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

./start.sh                  # 一条命令搞定：CDP 代理 + 三个 runner + 汇总面板
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
pkill -f "runners/hzrs.mjs"    # 停某一个
pkill -f "runners/"            # 全停
```

### 挂上定时任务（可选但建议）

```cron
*/5  * * * *  /绝对路径/jxjy-auto/watchdog.sh        # 进程死活 + 卡死重启 + 日志轮转
*/30 * * * *  /绝对路径/jxjy-auto/progress-check.sh  # 真实产出有没有在涨
5 8,20 * * *  /绝对路径/jxjy-auto/recalc.sh          # 新干线学时结算（平台限 3 次/天）
```

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
| `NC_CONCURRENCY` | `3` | 网易云课堂并行 worker 数。**改了要重跑 `NC_CONCURRENCY=<n> node setup-windows.mjs`** |
| `HZ_PLAY_VIDEO` | `0` | 新干线要不要真的播视频。它的学时按页面墙钟计，播视频对学时零收益却抢带宽，所以默认关 |
| `NC_VOLUME` | `0` | 网易云播放音量。**只能是 0 或很小的值**，且绝不能改成 `muted=true`（见坑 2） |
| `EXPOSE` | 空 | 面板监听范围。默认只绑 `127.0.0.1`；`lan` = 额外绑内网地址（手机能看，**但无鉴权**）；也可填具体 IP |
| `PORT` | `8848` / `3456` | 面板端口 / CDP 代理端口（两个程序各自读，别搞混） |
| `CHROME_PORT` | `9222` | Chrome 远程调试端口（`tools/cdp-proxy.mjs` 用，会自动探测 9222/9229/9333） |
| `SCREEN_W` | 自动探测 | 屏幕宽度，`setup-windows.mjs` 用来排布窗口 |
| `STALE_MIN` | `90` | 产出多少分钟没涨就告警 |

学习顺序、学科门类优先级这些，直接改 `runners/*.mjs` 顶部的常量：

```js
// runners/hzrs.mjs
const TYPE_ORDER = [15, 16, 17];                                 // 专业课程 → 行业公需 → 一般公需
const SYSTEM_PRIORITY = { '工学': 0, '理学': 1, '经济学': 2 };      // 专业课程里优先哪个门类
```

新干线**先学哪一类不用配**：runner 每轮读平台后台给的年度要求（`data.study` 里每类的
`r`=要求 / `s`=已得），谁还差就先补谁，硬性要求都满了再拿没有下限的类别去填总学时。

---

## 目录结构

```
start.sh / status.sh          启动、看状态
setup-windows.mjs             🔑 给要真播视频的 tab 各配一个独立可见 Chrome 窗口（决定速度）
dashboard.mjs                 汇总面板 HTTP 服务（:8848）
hours.mjs                     只读进度汇总（命令行版）
recalc.mjs / recalc.sh        杭州新干线学时结算
progress-check.mjs / .sh      结果导向看门狗
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

**5. 🔥 三个"静默空转"型 bug，症状一模一样：进程活着、日志刷得飞快、CPU 也在忙，但真实学时零增长。**
- 新干线会对**早已拿过学分、又被重新选课**的课程秒判 `finish=1` → 同一门课 60 秒一轮无限重开。
  （根因：`Study.UserIndex/index` 的已学课程列表**只返回 8 条**，不是全量，所以不知道它已经拿过学分。）
- 网易云播完后读的目录是**开播之前**加载的旧快照，永远显示未完成 → 同一课时反复重播。
- 🔴 **"完成"的判据挑错了一个**：上面那种秒判完成的课，平台**同样会把它移出「我的网络课程」**。
  于是"课程从我的网络课程里消失了"这个看似铁证的信号，把空转记成了成功——日志里全是 ✅，
  学时一点没涨，实测这样跑了一个半小时（2026-08-03）。
  **判据必须是时间**：`用时 < 该课应需时长的一半` → 一定是早就拿过学分，直接拉黑。
  写完成判定时先问自己：**这个信号在"失败"的情况下会不会也出现？**

  **教训：跑批自动化必须定期核对"外部真实产出"是否在涨，光看日志在动完全不够。**
  这就是 `progress-check.mjs` 存在的理由。

**6. 🔥 `document.visibilityState` 是按「窗口」算的：一个窗口里只有当前 tab 是 visible。**
所有要真播视频的 tab 挤在同一个窗口时，永远只有一个能跑满，抢 `/front` 是零和游戏。
hidden 页面会被 Chrome「密集节流」（定时器降到约 1 次/分钟），掐死 hls.js 的分片加载循环
→ 速率掉到 30~60%，而且**缓冲区出现断层但网络其实几毫秒就返回**，极具迷惑性。

**解法：给每个要真播视频的 tab 各配一个独立 Chrome 窗口**（`setup-windows.mjs`）。
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

这件事已经自动化：`heal-visibility.mjs`（watchdog 每 5 分钟调一次）发现专用 tab 变 hidden
就重建窗口 + 重启 runner，带 20 分钟冷却。屏幕解锁时它是 no-op，所以本地用的人不用管它。

试过但**没用**的（省得再试）：把窗口挪回 y=25（macOS 不会因为窗口移动就重算遮挡）、
`caffeinate -u -t N` 唤显示器（锁屏时唤不动）、`sudo pmset -a displaysleep 0`
（断开屏幕共享时 macOS 会直接把显示器睡掉，绕不过）。

判断是不是锁屏了：所有 tab 的 `document.visibilityState` 全是 `hidden`，
而 `osascript` 查到的前台 app 明明就是 Chrome。
又因为 macOS 的遮挡判定只在**完全**被盖住时才成立，把小窗口顶边放在 **y=25**（主窗口一般从 y≈122 起），
即使主窗口被抬到最上层，小窗口顶部那条仍然露着 → 依旧 visible。

实测吞吐对比（同一台机器，网易云课堂）：

| 配置 | 每路速率 | 合计吞吐 |
|---|---|---|
| 3 个 tab 挤在一个窗口 | 21% | 0.63x |
| 2 个 tab 挤在一个窗口 | 100% / 44% | 0.62x |
| 1 个 tab | 33~45% | 0.45x |
| **3 个 tab 各自独立窗口** | **100% / 100% / 100%** | **3.00x** |

试过但**行不通**的路子（省得你再试一遍）：
- `volume > 0` 让 Chrome 认为"页面在发声"从而豁免节流 → 有声播放需要 user activation，
  而 CDP 的合成点击拿不到（`navigator.userActivation.hasBeenActive` 恒 false，`/front` 之后也一样），
  `play()` 一直抛 `NotAllowedError`。
- `Emulation.setPageVisibilityOverride` → 新版 Chrome 已移除；
  `Page.setWebLifecycleState('active')` 能调通但改不了 `document.hidden`。

**6b. ⚠️ 并发不是越高越好，可能触发平台的账号共享风控。**
实测把网易云从"实际 0.6 路"提到"3 路满速"后约 15 分钟，接口开始返回
`HTTP 200 + {code:-2,"not_auth"}`——**登录态被判失效，但视频照常播**（CDN 不校验登录），
又是一次静默空转。加并发后务必盯 `progress-check.mjs`，出事就退回去。

**7. 新建 tab 会被 Chrome 扔进位置随机的新窗口**，经常正好压住上面那几个必须保持可见的小窗口。
不需要可见的 tab（比如新干线的课程页）要主动挪走：`cdp.parkWindow()`。
另外**认新建窗口里的 tab 必须用「建之前/之后的 targetId 差集」**，按 URL 找会命中别处早就存在的同址老 tab。

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
