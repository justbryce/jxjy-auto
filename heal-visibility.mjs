#!/usr/bin/env node
// 可见性自愈：发现"专用窗口里的 tab 变成 hidden"就重建窗口布局并重启 runner。
//
// ── 为什么需要它 ──────────────────────────────────────────────────────────
// macOS **在锁屏那一刻把当时存在的所有窗口标成 occluded，之后在锁屏期间不再重新计算**。
// 于是 `setup-windows.mjs` 辛苦摆好的那几个专用窗口全部退回 `hidden`，
// 靠 JS 定时器喂数据的播放器（hls.js）被 Chrome 密集节流，速率掉到 30~40%。
//
// 关键发现（2026-08-03 实测）：**锁屏之后新建的窗口是 `visible` 的，而且完全不被节流。**
// 已验证：锁屏 + 显示器休眠状态下新建窗口，setInterval 161 秒整整跑了 161 次（1.000/s），
// rAF 也是满帧。所以不需要重启 Chrome、不需要改锁屏设置、不需要加免节流启动参数 ——
// **锁屏后重建一次窗口就能恢复满速。**
//
// 试过但没用的（省得再试）：
//   · 把窗口挪回 y=25（macOS 不会因为窗口移动就重算遮挡）
//   · `caffeinate -u -t N` 唤醒显示器（锁屏时唤不动，且醒了也是锁屏界面盖住一切）
//   · `sudo pmset -a displaysleep 0`（断开屏幕共享时 macOS 会直接把显示器睡掉，绕不过）
//
// ── 本地机器上会不会误触发 ──────────────────────────────────────────────
// 不会有代价：屏幕解锁、窗口没被压住时这些 tab 一直是 `visible`，本脚本什么都不做。
// 只有真的掉了可见性（锁屏 / 窗口被别的全屏窗口盖住）才会动手，而那种情况下
// 不动手的后果就是**默默地慢 3 倍**。所以默认开启，不做成开关。
//
// ── ⚠️ osascript 超时：观察到的真实原因 ──────────────────────────────────
// 自愈要靠 `osascript` 建窗口。实测失败模式是 `spawnSync osascript ETIMEDOUT`：
// **6 路视频正在播的时候，Chrome 建一个窗口能花十几秒**（空载约 5s），
// 原来 setup-windows.mjs 里给的 15s 超时不够用 → 整轮自愈白跑。已放宽到 90s。
//
// （曾经怀疑是 macOS 的 Apple Events 授权按"责任进程"给、cron 起的进程卡在
//   看不见的授权弹窗上 —— 但没有证据支持，实际观察到的就是负载下的超时。
//   本脚本仍然以 `--daemon` 常驻由 start.sh 拉起：日志更集中、不受 cron 环境差异影响，
//   顺带也绕开了上面那个"万一真是授权问题"的风险。cron 里的 watchdog 只查它活着。）
//
// 用法：
//   node heal-visibility.mjs           跑一次
//   node heal-visibility.mjs --dry     只报告不动手
//   node heal-visibility.mjs --daemon  常驻，每 HEAL_INTERVAL_SEC（默认 300）秒查一次

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as cdp from './lib/cdp.mjs';
import { displayAsleep } from './lib/display.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const log = cdp.makeLogger('heal');
const DRY = process.argv.includes('--dry');
// 两次自愈之间的冷却。重建窗口 + 重启 runner 有代价（丢掉最多几十秒的播放进度），
// 而且如果是"永远修不好"的原因（比如 Chrome 整个被别的 App 全屏盖住），
// 不设冷却就会每 5 分钟重启一次，比不修还糟。
const COOLDOWN_MIN = Number(process.env.HEAL_COOLDOWN_MIN || 30);
const STAMP = path.join(HERE, 'state', 'heal.json');

// 自愈**没起作用**时的退避上限。连续几轮修完还是 hidden，说明病因不是锁屏
// （比如用户自己的终端全屏盖住了 Chrome），再修多少次都一样，只会白白毁掉播放进度。
const BACKOFF_MAX_MIN = Number(process.env.HEAL_BACKOFF_MAX_MIN || 240);
// 判定"其实没被节流"的速率线。163 日志里每条进度都带「速率xx%」。
const RATE_OK = Number(process.env.HEAL_RATE_OK || 85);

// ── 真正该看的指标是「播放速率」，不是 visibilityState ──────────────────────
// 2026-08-04 血的教训：Chrome 的密集节流只拦**起播**，**已经在播的媒体元素不吃定时器节流**。
// 所以 tab 全 hidden 但速率 100% 是常态，此时自愈是纯亏损 —— 重启 runner 会把
// 10 路正在播的课时全部打回 0%，而队列里 30~90 分钟的长课时根本熬不到下一次重启。
// 实测代价：42 次自愈 / 一天，网易云从 10:29 起到凌晨 1 点**一个课时都没完成**。
// 规则：近期速率健康就绝不动手，不管 visibilityState 是什么。
function recentRate() {
  try {
    const f = path.join(HERE, 'logs', 'study163.log');
    const buf = fs.readFileSync(f, 'utf8');
    const lines = buf.slice(-200_000).split('\n').slice(-400);
    const rates = [];
    for (const l of lines) {
      const m = l.match(/速率(\d+)%/);
      if (m) rates.push(Number(m[1]));
    }
    if (rates.length < 5) return null;                 // 样本太少，说不清
    const tail = rates.slice(-40).sort((a, b) => a - b);
    return tail[Math.floor(tail.length / 2)];          // 中位数，抗单个异常值
  } catch { return null; }
}

// 需要保持可见的 tab：state 文件 → 字段名
function wantVisible() {
  const out = [];
  const read = f => { try { return JSON.parse(fs.readFileSync(path.join(HERE, 'state', f), 'utf8')); } catch { return null; } };
  const zj = read('zjsjczx.json');
  if (zj?.target) out.push({ who: 'zj', tab: zj.target });
  const nc = read('study163.json');
  if (nc) for (const [k, v] of Object.entries(nc)) if (/^tab\d+$/.test(k) && v) out.push({ who: `163-${k}`, tab: v });
  return out;
}

function clearStreak() {
  try {
    const s = JSON.parse(fs.readFileSync(STAMP, 'utf8'));
    if (s.streak) { s.streak = 0; fs.writeFileSync(STAMP, JSON.stringify(s, null, 2)); }
  } catch { }
}

async function main() {
  const want = wantVisible();
  if (!want.length) { log('state 里还没有登记要保持可见的 tab，跳过'); return; }

  const bad = [];
  for (const w of want) {
    // 注意用 evalJs 不是 evalJson —— visibilityState 是裸字符串，不是 JSON
    const vis = await cdp.evalJs(w.tab, 'document.visibilityState').catch(() => null);
    if (vis == null) { bad.push({ ...w, vis: 'tab 没了' }); continue; }
    if (vis !== 'visible') bad.push({ ...w, vis });
  }

  if (!bad.length) { log(`${want.length} 个专用 tab 都是 visible，无需处理`); clearStreak(); return; }
  log(`⚠ ${bad.length}/${want.length} 个专用 tab 丢了可见性：` + bad.map(b => `${b.who}=${b.vis}`).join(' '));

  // hidden 本身不是伤害，掉速才是。先看真实速率再决定动不动手。
  const rate = recentRate();
  const gone = bad.filter(b => b.vis === 'tab 没了').length;
  if (rate != null && rate >= RATE_OK && gone === 0) {
    log(`  但近期播放速率中位数 ${rate}%（≥${RATE_OK}%）—— hidden 没造成掉速，本轮不动手。`);
    log('     已经在播的媒体元素不吃定时器节流；此时重启 runner 只会把在播的课时全打回 0%。');
    return;
  }
  if (rate != null) log(`  近期播放速率中位数 ${rate}%${gone ? `，另有 ${gone} 个 tab 没了` : ''} —— 确实在掉速`);

  // 🔴 **显示器睡着的时候绝对不能自愈。**
  // 自愈的原理是"新建的窗口是 visible 的"，但那只在**屏幕锁了、显示器还亮着**时成立。
  // 显示器一睡，连新建窗口也是 occluded —— 重建不但没用，还会把**本来能播的老 tab 换成永远播不了的新 tab**
  // （网易云的新 tab 必须可见过一次才肯挂载播放器），等于自己把还能跑的部分毁掉。实测踩过。
  if (displayAsleep()) {
    log('  🚨 显示器处于休眠状态 —— 重建窗口也救不回来（新窗口同样是 occluded），本轮不动手。');
    log('     网易云会彻底停摆（SPA 播放器在被节流的 hidden 页里挂载不出来），另外两站不受影响。');
    log('     唤不醒是实测结论：caffeinate -u/-dimsu、敲键、pmset 全试过。只能人到机器前唤醒屏幕。');
    try {
      const A = path.join(HERE, 'logs', 'ALERT.log');
      const last = fs.existsSync(A) ? fs.statSync(A).mtimeMs : 0;
      if (Date.now() - last > 30 * 60_000)     // 半小时最多告警一次，别刷屏
        fs.appendFileSync(A, `${new Date().toLocaleString('zh-CN')} 🚨 显示器休眠，网易云停摆（需人工唤醒屏幕）\n`);
    } catch { }
    return;
  }
  log('  原因多半是机器锁屏（macOS 锁屏时把当时存在的窗口全标成 occluded，之后不再重算）');

  let stamp = {};
  try { stamp = JSON.parse(fs.readFileSync(STAMP, 'utf8')); } catch { }
  // 上一轮修完症状又回来了 → 说明这个病因自愈治不了，指数退避。
  // （最典型的：用户自己的终端/别的 App 全屏盖住整个主屏，重建多少次窗口都会再被盖回去。）
  const streak = Number(stamp.streak || 0);
  const cool = Math.min(COOLDOWN_MIN * 2 ** streak, BACKOFF_MAX_MIN);
  const sinceMin = stamp.at ? (Date.now() - stamp.at) / 60000 : Infinity;
  if (sinceMin < cool) {
    log(`  ${sinceMin.toFixed(0)} 分钟前刚自愈过（冷却 ${cool} 分钟${streak ? `，已连续 ${streak} 次没治好 → 退避中` : ''}），这次跳过`);
    return;
  }
  if (streak >= 3) {
    log(`  ⚠ 连续 ${streak} 次自愈都没能让症状消失 —— 病因基本不是锁屏。`);
    log('     最可能：Chrome 被别的 App（终端 / 全屏窗口）整个盖住。这种情况重建窗口治不好，');
    log('     但好消息是**已经在播的视频不掉速**，真正的损失只有"新课时起播难"。');
  }
  if (DRY) { log('  --dry，只报告不动手'); return; }

  log('  重建窗口布局……（锁屏后新建的窗口是 visible 的，这是整个自愈的原理）');
  const run = (cmd, args) => execFileSync(cmd, args, { cwd: HERE, encoding: 'utf8', timeout: 300_000 });
  try {
    run('node', ['setup-windows.mjs']).trim().split('\n').forEach(l => log('  | ' + l));
  } catch (e) { log('  ❌ setup-windows 失败：', e.message); return; }

  // 必须真重启 runner：tab id 只在进程启动时读一次 state/，不重启不会接管新 tab
  log('  重启 runner 接管新 tab');
  try { run('pkill', ['-f', 'runners/']); } catch { }        // 没进程时 pkill 返回 1，不算错
  await new Promise(r => setTimeout(r, 3000));
  try { run('bash', ['start.sh']).trim().split('\n').filter(l => /✅|❌/.test(l)).forEach(l => log('  | ' + l)); }
  catch (e) { log('  ❌ start.sh 失败：', e.message); return; }

  fs.writeFileSync(STAMP, JSON.stringify({ at: Date.now(), fixed: bad.map(b => b.who), streak: streak + 1 }, null, 2));
  log(`✅ 自愈完成（若下轮症状消失，streak 会清零；否则冷却翻倍到 ${Math.min(cool * 2, BACKOFF_MAX_MIN)} 分钟）`);
}

// 🔒 单实例锁。两个守护同时跑会**互相打架**：各自建一整套窗口，彼此覆盖，
// 结果新建的窗口也全是 hidden，自愈反而把情况弄得更糟（实测踩到，日志里满屏
// 「有 2 个新 tab 都是 X，取第一个」就是这个race 的信号）。
// 用 PID 文件 + 存活校验，比 pgrep 可靠（pgrep 在不同调用上下文里会漏匹配）。
const PIDFILE = path.join(HERE, 'state', 'heal.pid');
function claimSingleton() {
  try {
    const old = Number(fs.readFileSync(PIDFILE, 'utf8').trim());
    if (old && old !== process.pid) {
      try { process.kill(old, 0); return false; }   // 还活着 → 让位
      catch { /* 进程没了，可以接管 */ }
    }
  } catch { }
  fs.writeFileSync(PIDFILE, String(process.pid));
  return true;
}

if (process.argv.includes('--daemon')) {
  if (!claimSingleton()) { log('已经有一个自愈守护在跑了，本进程退出（避免两个实例互相覆盖窗口）'); process.exit(0); }
  const every = Number(process.env.HEAL_INTERVAL_SEC || 300) * 1000;
  log(`常驻模式启动（pid ${process.pid}），每 ${every / 1000}s 检查一次`);
  // 单次异常不能把守护进程带走 —— 它挂了就没人修可见性了，而那种失败是"静默变慢"，最难发现。
  for (; ;) {
    await main().catch(e => log('💥 本轮异常，继续:', e.message));
    await new Promise(r => setTimeout(r, every));
  }
} else {
  main().catch(e => { log('💥', e.message); process.exit(1); });
}
