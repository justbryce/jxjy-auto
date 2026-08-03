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
// ── ⚠️ 为什么要常驻，而不是让 cron 每 5 分钟跑一次 ────────────────────────
// 自愈要靠 `osascript` 建窗口，而 macOS 的 Apple Events 授权是**按"责任进程"**给的。
// 从 cron / launchd 里跑，责任进程不是你交互式授权过的那个终端 →
// `osascript` 会**卡住等一个没人看得见的授权弹窗**，最后超时（实测：SIGTERM，15s）。
// 所以本脚本要以 `--daemon` 常驻，由 `start.sh`（你手动跑的、已授权的上下文）拉起，
// cron 里的 watchdog 只负责检查它还活着。
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

const HERE = path.dirname(fileURLToPath(import.meta.url));
const log = cdp.makeLogger('heal');
const DRY = process.argv.includes('--dry');
// 两次自愈之间的冷却。重建窗口 + 重启 runner 有代价（丢掉最多几十秒的播放进度），
// 而且如果是"永远修不好"的原因（比如 Chrome 整个被别的 App 全屏盖住），
// 不设冷却就会每 5 分钟重启一次，比不修还糟。
const COOLDOWN_MIN = Number(process.env.HEAL_COOLDOWN_MIN || 20);
const STAMP = path.join(HERE, 'state', 'heal.json');

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

  if (!bad.length) { log(`${want.length} 个专用 tab 都是 visible，无需处理`); return; }
  log(`⚠ ${bad.length}/${want.length} 个专用 tab 丢了可见性：` + bad.map(b => `${b.who}=${b.vis}`).join(' '));
  log('  原因多半是机器锁屏（macOS 锁屏时把当时存在的窗口全标成 occluded，之后不再重算）');

  let stamp = {};
  try { stamp = JSON.parse(fs.readFileSync(STAMP, 'utf8')); } catch { }
  const sinceMin = stamp.at ? (Date.now() - stamp.at) / 60000 : Infinity;
  if (sinceMin < COOLDOWN_MIN) {
    log(`  ${sinceMin.toFixed(0)} 分钟前刚自愈过（冷却 ${COOLDOWN_MIN} 分钟），这次跳过`);
    return;
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

  fs.writeFileSync(STAMP, JSON.stringify({ at: Date.now(), fixed: bad.map(b => b.who) }, null, 2));
  log('✅ 自愈完成');
}

if (process.argv.includes('--daemon')) {
  const every = Number(process.env.HEAL_INTERVAL_SEC || 300) * 1000;
  log(`常驻模式启动，每 ${every / 1000}s 检查一次`);
  // 单次异常不能把守护进程带走 —— 它挂了就没人修可见性了，而那种失败是"静默变慢"，最难发现。
  for (; ;) {
    await main().catch(e => log('💥 本轮异常，继续:', e.message));
    await new Promise(r => setTimeout(r, every));
  }
} else {
  main().catch(e => { log('💥', e.message); process.exit(1); });
}
