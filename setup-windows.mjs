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

// 顶边统一 25，横向排开互不重叠；高度 495 够 Chrome 最小窗口
const W = Number(process.env.NC_CONCURRENCY || 3);      // 163 要几个 worker 就开几个窗口
// 屏幕宽度：优先现查，查不到再用 1920 兜底。可用 SCREEN_W 覆盖。
let SCREEN_W = Number(process.env.SCREEN_W || 0);
if (!SCREEN_W) {
  try {
    SCREEN_W = Number(execFileSync('osascript', ['-e',
      'tell application "Finder" to get item 3 of (get bounds of window of desktop)'],
      { encoding: 'utf8', timeout: 8000 }).trim()) || 0;
  } catch { }
}
if (!SCREEN_W) SCREEN_W = 1920;
const COLS = W + 1;                                      // +1 给 zjsjczx
const CW = Math.floor(SCREEN_W / COLS);
const col = i => [i * CW, 25, (i + 1) * CW, 520];

const PLAN = [
  { key: 'zj', file: 'zjsjczx.json', field: 'target', bounds: col(COLS - 1), url: 'https://engineer.zjsjczx.org.cn/zg/student/learning-center' },
  ...Array.from({ length: W }, (_, i) => ({
    key: `163-w${i}`, file: 'study163.json', field: `tab${i}`, bounds: col(i),
    url: 'https://study.163.com/my#/courses',
  })),
];

// 多行 AppleScript 用 -e 逐行传，别塞进一个字符串（osascript 会报语法错）
const osa = (...lines) => execFileSync('osascript',
  lines.flatMap(l => ['-e', l]), { encoding: 'utf8', timeout: 15000 }).trim();

const allIds = async () => new Set((await cdp.findTabs(() => true)).map(t => t.targetId));

// 先把上一轮建的专用 tab 关掉。不关的话每跑一次就多 4 个窗口 ——
// 锁屏自愈（heal-visibility.mjs）会反复调本脚本，实测几轮下来能攒到十几个窗口，
// 既占内存，又让"主窗口抬回最前"这一步越来越不准。
for (const p of PLAN) {
  const f = path.join(HERE, 'state', p.file);
  let d = {}; try { d = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { }
  const old = d[p.field];
  if (old && await cdp.tabAlive(old)) { await cdp.closeTab(old).catch(() => { }); log(`回收旧 tab ${p.key} ${String(old).slice(0, 8)}`); }
}

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
