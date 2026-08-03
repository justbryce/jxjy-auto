# 给 AI Agent 的上手指南

你正在接手 `jxjy-auto`。这份文件按「你最可能被要求做的事」组织，比 README 更适合你的工作方式。
README 面向人，讲的是"这是什么"；这份讲的是"你该怎么动手、以及别踩什么"。

---

## 30 秒理解这个项目

一句话：**用 CDP 接管用户日常用的那个 Chrome，把继续教育平台的课程视频一个个按 1x 真实速度播完。**

三条不可动摇的设计原则，改代码前先记住：

1. **不伪造进度。** 所有上报请求都由平台页面自己发出，脚本只负责"把视频播起来、播完换下一个"。
   如果用户要求你改成倍速/直接调上报接口/篡改 `currentTime` 跳过内容——**那超出了这个项目的定位**，
   先跟用户确认清楚他真正想要什么，别默默改。
2. **共用用户的 Chrome，就要当好客人。** 这个 Chrome 里可能还跑着用户的其他自动化。
   抢"可见窗口"槽位、`/front`、关 tab、重启代理之前，先确认不会踩到别人。
3. **日志在滚 ≠ 有产出。** 见下面「最容易骗过你的失败模式」。

---

## 三个平台的机制差异（这是整个项目的核心）

| | 平台 | 计时机制 | 要真播视频吗 | 并发 |
|---|---|---|---|---|
| `runners/zjsjczx.mjs` | 浙江工信 | 上报真实 `currentTime`，服务端取最大值 | **要** | 无限制 |
| `runners/hzrs.mjs` | 杭州新干线 | 按**两次上报之间的真实间隔**加秒 | **不要**（页面开着就计时） | **同时只能学一门** |
| `runners/study163.mjs` | 网易云课堂 | 上报真实 `currentTime` | **要** | 可多课时并行 |

**"要不要真播视频"决定了一切**：要真播的站点必须拿到"可见的 Chrome 窗口"，否则被节流到 30~60%
（详见 README 坑 6）。不要真播的站点反而要主动让开，别去抢。

---

## 常见任务 → 直接去哪

| 用户说 | 你做什么 |
|---|---|
| "跑起来" / "怎么启动" | `./start.sh`（会自动拉起 CDP 代理）→ `node setup-windows.mjs` → **`pkill -f "runners/" && ./start.sh`**。<br>最后这步必须真 pkill：`start.sh` 会跳过已在跑的 runner，而 tab id 只在进程启动时读一次盘 |
| "现在什么进度" | `node hours.mjs`（命令行）或 `curl -s localhost:8848/json`（结构化） |
| "卡住了 / 没在动" | 走下面「排错决策树」 |
| "加一个新平台" | 抄 `runners/` 里最像的那个；README 末尾有三个必答问题 |
| "调快一点" | 先量再改：`node progress-check.mjs` 看真实产出，别凭日志判断。见「性能」 |
| "学时怎么没涨" | 新干线要 `node recalc.mjs` 手动结算（平台限 3 次/天）；其他站是实时的 |

---

## 🔴 最容易骗过你的失败模式

这个项目踩过三次同一类坑，**症状完全一样：进程活着、日志刷得飞快、CPU 也在忙，但真实学时零增长。**
进程级健康检查对这类问题完全无感。

1. **平台对"早已学完又被重新选课"的课秒判完成** → 同一门课 60 秒一轮无限重开。
2. **读到的是过期的 DOM 快照** → 课时明明播完了，目录里还显示未完成 → 反复重播同一课时。
3. **登录态失效，但返回 HTTP 200 + `{code:-2,"not_auth"}`** → 拿到空列表，脚本以为"没课可学"，
   而视频照播（CDN 不校验登录）。

**所以：判断"在不在正常工作"，永远以平台上外部可验证的数字为准，不要看日志在不在滚。**
```bash
node progress-check.mjs      # 对比 24 小时内的历史快照，看三个平台的产出有没有在涨
```
它每 30 分钟由 cron 跑一次，90 分钟没涨就写 `logs/ALERT.log` + 发系统通知。
**你新增任何平台或改动调度逻辑时，都要在 `progress-check.mjs` 里加上对应的产出指标。**

---

## 排错决策树

```
用户说"没在动"
├─ 进程还在吗？          pgrep -fl "runners/"
│   └─ 不在 → ./start.sh；看 logs/<站>.log 最后的 💥 堆栈
├─ 真实产出在涨吗？      node progress-check.mjs
│   └─ 不涨但进程活着 → 大概率是上面那三种"静默空转"，去读对应 runner 的日志找重复模式
│                        （同一门课/同一课时反复出现 = 中招了）
├─ 登录态还在吗？        node hours.mjs  → 报"登录态失效/取数失败"就是过期了
│   └─ 过期 → 只能让用户在 Chrome 里手动重新登录，脚本不碰登录
├─ CDP 代理通吗？        curl -s localhost:3456/health
│   └─ 不通 → Chrome 是不是关了远程调试？是不是有别的工具占着调试连接？
│             （Chrome 同一时间只允许一个 /devtools/browser 连接）
└─ 速率不对（163 特有）  日志里的「速率 xx%」低于 90%
    └─ tab 丢了可见性 → node setup-windows.mjs 重建窗口布局
```

---

## 改代码时的硬规则

这些都是踩出来的，违反了会得到很难查的 bug：

```js
// ❌ 永远不要这样 —— 视频加载不动时 Promise 永不 settle，CDP eval 挂到 45s 超时把进程带崩
await evalJs(t, '(async()=>{ await document.querySelector("video").play() })()')

// ✅ fire-and-forget，之后单独读状态
await evalJs(t, '(()=>{const v=document.querySelector("video");const p=v.play();p&&p.catch(()=>{});return 1})()')
await sleep(3000)
const s = await evalJson(t, VSTAT)
```

- **静音只能 `volume=0` + `muted=false`。** `muted=true` 会被 Chrome 在 play 后约 6ms 直接暂停。
- **别自己开裸 CDP 连接**（`ws://127.0.0.1:9222/devtools/browser`）。会弹调试授权框，
  而且 Chrome 同一时间只允许一个，你会把别人挤掉或者自己连不上。统一走 `lib/cdp.mjs`。
- **认新建窗口里的 tab，要用「建之前/之后的 targetId 差集」**，别按 URL 找 —— 会命中早就存在的同址老 tab。
- **每个 runner 的主循环都要能吞异常**（`main()` 里 try/catch + sleep 重试）。单次 eval 超时不该杀进程。
- **判"完成"要用平台的权威字段，并且搞清楚它是不是实时更新的。** 比如新干线的 `validstudytime`
  在学习途中查到的常常还是 0，只能用 `playTime`（本次会话秒数）判"在不在推进"。

---

## 代码地图

```
lib/cdp.mjs          所有 CDP 调用的唯一入口 + 可见性/窗口工具 + 状态持久化
                     · kickVisible()  临时让 tab 可见（有文件锁，多 runner 不打架）
                     · parkWindow()   把不需要可见的窗口挪走，别压住要可见的
                     · activateChrome() 把 Chrome 提到前台
runners/*.mjs        一个平台一个独立进程，互不影响。结构都是
                     main(){ while(true) try{ loop() } catch{ sleep } }
setup-windows.mjs    给要真播视频的 tab 各配一个独立可见窗口 —— **决定速度的关键**
dashboard.mjs        :8848 面板，现查平台接口。加平台要在这里加取数函数
progress-check.mjs   结果导向看门狗。加平台要在这里加产出指标
watchdog.sh          进程看门狗（cron */5）
tools/cdp-proxy.mjs  自带的最小 CDP 代理，零依赖
state/               运行状态：tab id、黑名单、跳过的课时。删了会重新发现，不会丢学时
logs/                日志 + 异常截图
```

---

## 性能：先量再改

163 的吞吐差过 4.8 倍，全在于"tab 有没有真的 visible"。改并发前先量：

```bash
# 看每个 worker 的实时速率（100% = 真实 1x）
grep 速率 logs/study163.log | tail
```

实测数据（同一台机器）：3 个 tab 挤在一个窗口 = 0.63x；**3 个 tab 各自独立窗口 = 3.00x**。
`NC_CONCURRENCY` 和 `setup-windows.mjs` 建的窗口数**必须一致**，否则多出来的 worker 只能拿到 30% 速率。

⚠️ 并发不是越高越好：实测把 163 从 0.6 路提到 3 路满速后约 15 分钟，账号被判 `not_auth`
（疑似触发平台的账号共享风控）。**加并发后要盯着 `progress-check.mjs`**，出事就退回去。

---

## 环境依赖

- **macOS only**（用了 `osascript` 管窗口、`caffeinate` 防休眠、BSD `stat -f`）。
  移植到 Linux 主要要重写 `setup-windows.mjs` 和 `lib/cdp.mjs` 里的 `activateChrome/parkWindow`。
- **Node 22+**（原生 `WebSocket`），零第三方依赖。
- **Chrome 必须开着远程调试**，并且已经手动登录好各平台。脚本不碰登录。

---

## 你不该做的事

- 不要替用户登录、不要处理验证码、不要存凭据。
- 不要为了"提速"去改上报数据、跳过视频内容、或者调 `playbackRate`。
- 不要停掉那个 CDP 代理，除非你确认没有别的工具在用它。
- 不要在没量过的情况下调并发。
- 不要把 `state/` `logs/` 和本机私有笔记提交进 git（`.gitignore` 已排除，别绕过）。
