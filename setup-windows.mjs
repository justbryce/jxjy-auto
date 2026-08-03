#!/usr/bin/env node
// 给"需要真实播放视频"的 runner 各配一个独立的 Chrome 小窗口，让它们的 tab 常驻 visible。
//
// 为什么需要：Chrome 对 hidden 页面做密集节流（定时器降到 ~1 次/分钟），
// hls.js（网易云）的分片加载循环被掐住 → 速率掉到 30~60%；原生 <video src=mp4>（浙江工信）
// 更狠，hidden 时压根不开始加载。而**一个窗口里只有当前 tab 是 visible**，
// 所以全部挤在一个窗口里时，永远只有一个能跑满。
//
// 关键技巧：macOS 的遮挡判定是**按窗口**的，而且只有被**完全**盖住才算 occluded。
// 把小窗口顶边放在 y=25（主窗口从 y≈122 起），即使主窗口被抬到上层，
// 小窗口顶部那条仍然露着 → Chrome 认为它 visible。实测有效。
//
// 用法：node setup-windows.mjs  然后 **pkill -f "runners/" && ./start.sh**
//      （必须真重启：runner 的 tab id 只在进程启动时读一次 state/，不重启不会接管新 tab）

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as cdp from './lib/cdp.mjs';
import { sleep } from './lib/cdp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const log = cdp.makeLogger('windows');

// ⚠️ 自己读一遍 env.local。start.sh 会 source 它，但**本脚本经常被直接调用**
//    （手动跑、或者被 heal-visibility.mjs 调用），那时候 NC_CONCURRENCY 就丢了 →
//    窗口数按默认 3 建，而 runner 按 env.local 的 6 起 → 多出来的 worker 没有可见窗口，
//    默默地只跑 30% 速率。踩过一次。
for (const line of (() => { try { return fs.readFileSync(path.join(HERE, 'env.local'), 'utf8').split('\n'); } catch { return []; } })()) {
  const m = line.match(/^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

const W = Number(process.env.NC_CONCURRENCY || 3);      // 163 要几个 worker 就开几个窗口

// 可用桌面范围。注意 `Finder` 的 desktop bounds **只给主屏**，看不出有没有第二块屏；
// 而"建个窗口往外推、看系统夹不夹回来"也不靠谱 —— macOS 允许窗口部分超出屏幕边缘，
// 读回来的值会比真实桌面宽（实测多报了 350px）。所以老老实实读 system_profiler。
//
// 多屏：副屏在**左边**时坐标是负的，用 SCREEN_X0 指定最左边界（如 -1920）；
// 在右边就只需要把 SCREEN_W 调大。两个都能用环境变量直接覆盖，跳过自动探测。
const osaProbe = (...lines) => execFileSync('osascript',
  lines.flatMap(l => ['-e', l]), { encoding: 'utf8', timeout: 90000 }).trim();
let SCREEN_X0 = Number(process.env.SCREEN_X0 || 0);
let SCREEN_W = Number(process.env.SCREEN_W || 0);
if (!SCREEN_W) {
  try {
    const j = JSON.parse(execFileSync('system_profiler', ['SPDisplaysDataType', '-json'],
      { encoding: 'utf8', timeout: 20000 }));
    const ds = (j.SPDisplaysDataType || []).flatMap(g => g.spdisplays_ndrvs || []);
    const px = d => Number(String(d._spdisplays_resolution || d.spdisplays_resolution || '')
      .match(/(\d+)\s*x/)?.[1] || 0);
    const online = ds.filter(d => px(d) > 0);
    if (online.length) {
      SCREEN_W = online.reduce((a, d) => a + px(d), 0);
      if (online.length > 1) log(`检测到 ${online.length} 块屏：${online.map(px).join(' + ')} = ${SCREEN_W}px`);
    }
  } catch { }
}
if (!SCREEN_W) {
  try { SCREEN_W = Number(osaProbe('tell application "Finder" to get item 3 of (get bounds of window of desktop)')) || 0; } catch { }
}
if (!SCREEN_W) SCREEN_W = 1920;
log(`桌面范围 x=${SCREEN_X0}..${SCREEN_X0 + SCREEN_W}（宽 ${SCREEN_W}px）`);
const COLS = W + 1;                                      // +1 给 zjsjczx
// 窗口**层叠**排布，不是并排。
// 关键：macOS 的遮挡判定要求**完全**被盖住才算 occluded —— 所以每个窗口只要露出一条边就够了，
// 不需要各自占一整列。并排的话 1920 宽最多摆 4 个（Chrome 有约 400px 的最小窗口宽度，
// 你把 bounds 设得更窄它会自己拉宽，结果后面的窗口把前面的完全盖死）。
// 层叠之后每个窗口露出 `STEP` 宽 × (122-25) 高的一条（主窗口从 y≈122 起，上面那条一直露着），
// 就能开到十几个 worker 都保持 visible。
const MINW = 400;                                        // Chrome 最小窗口宽度，比这窄它会自己拉宽
const STEP = Math.max(48, Math.floor((SCREEN_W - MINW) / COLS));
const CW = Math.max(MINW, STEP);
const WIN_TOP = 25, WIN_BOT = 520;
// Chrome 会把顶边夹到菜单栏下沿（25 → 30），底边跟着平移。回收旧窗口时要按这组读回值匹配。
const WIN_TOP_READBACK = 30, WIN_BOT_READBACK = WIN_BOT + (WIN_TOP_READBACK - WIN_TOP);
const col = i => [SCREEN_X0 + i * STEP, WIN_TOP, SCREEN_X0 + i * STEP + CW, WIN_BOT];

const PLAN = [
  { key: 'zj', file: 'zjsjczx.json', field: 'target', bounds: col(COLS - 1), url: 'https://engineer.zjsjczx.org.cn/zg/student/learning-center' },
  ...Array.from({ length: W }, (_, i) => ({
    key: `163-w${i}`, file: 'study163.json', field: `tab${i}`, bounds: col(i),
    url: 'https://study.163.com/my#/courses',
  })),
];

// 多行 AppleScript 用 -e 逐行传，别塞进一个字符串（osascript 会报语法错）
// ⚠️ 超时给足。原来给 15s，在「6 路视频正在播」的时候 Chrome 建一个窗口就能超 ——
//    表现是 `spawnSync osascript ETIMEDOUT`，整个 setup-windows 失败、自愈这一轮白跑。
//    空载时每个窗口约 5s，满载能到十几秒，所以按最坏情况给 90s。
const OSA_TIMEOUT = Number(process.env.OSA_TIMEOUT_MS || 90000);
const osa = (...lines) => execFileSync('osascript',
  lines.flatMap(l => ['-e', l]), { encoding: 'utf8', timeout: OSA_TIMEOUT }).trim();

const allIds = async () => new Set((await cdp.findTabs(() => true)).map(t => t.targetId));

// 先把上一轮建的专用窗口全部关掉。不关的话每跑一次就多 N 个窗口 ——
// 锁屏自愈（heal-visibility.mjs）会反复调本脚本，实测攒到过 16 个窗口。
//
// 按**窗口几何**扫，不按 state 里记的 tab id：state 只记得最后一次的 id，
// 中途异常退出、或者连着跑两次，前面那批就永远没人回收了。
// ⚠️ Chrome 会把 y=25 夹成 30、bottom 相应变 525（菜单栏），所以匹配的是**读回来的**值，
//    不是我们设进去的值。改了 col() 的 y 记得同步改这里。
try {
  const n = osaProbe('tell application "Google Chrome"',
    'set k to 0',
    'repeat with i from (count of windows) to 1 by -1',
    '  set b to bounds of window i',
    `  if (item 2 of b) = ${WIN_TOP_READBACK} and (item 4 of b) = ${WIN_BOT_READBACK} then`,
    '    close window i',
    '    set k to k + 1',
    '  end if',
    'end repeat',
    'return k as string',
    'end tell');
  if (Number(n) > 0) log(`回收上一轮的 ${n} 个专用窗口`);
} catch (e) { log('回收旧窗口失败（不影响后续）:', e.message); }

for (const p of PLAN) {
  // ⚠️ 必须用"建窗口前后的 targetId 差集"来认新 tab。按 URL 找会命中主窗口里早就存在的同址老 tab
  //    （比如 study.163.com/my 那种），结果把老 tab 当成新窗口的 tab 写进 state，白忙一场。
  const before = await allIds();
  osa('tell application "Google Chrome"',
      'set w to make new window',
      `set URL of active tab of w to "${p.url}"`,
      `set bounds of w to {${p.bounds.join(', ')}}`,
      'end tell');
  await sleep(5000);
  const after = await allIds();
  const id = [...after].find(x => !before.has(x));
  if (!id) { log(`❌ ${p.key} 没认出新建的 tab`); continue; }

  const f = path.join(HERE, 'state', p.file);
  let d = {}; try { d = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { }
  d[p.field] = id;
  fs.writeFileSync(f, JSON.stringify(d, null, 1));

  const vis = await cdp.evalJs(id, 'document.visibilityState').catch(() => '?');
  log(`${p.key} → ${id.slice(0, 8)} bounds=${p.bounds.join(',')} visible=${vis}`);
}

// 主窗口抬回最前，这样后续 /new 建的新 tab（hzrs 每门课都会建）落在主窗口里，
// 不会挤进我们这几个专用小窗口把它们的 active tab 顶掉。
try {
  const n = Number(osa('tell application "Google Chrome" to count of windows'));
  osa(`tell application "Google Chrome" to set index of window ${n} to 1`);
  log(`主窗口（共 ${n} 个窗口）已抬回最前`);
} catch (e) { log('抬主窗口失败:', e.message); }

log('完成。现在执行：pkill -f "runners/" && ./start.sh  —— 必须真重启才会接管新 tab');
