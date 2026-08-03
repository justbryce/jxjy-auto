// 统一的 CDP 客户端。所有 CDP 调用都从这里走。
// 只跟一个常驻的 HTTP 代理说话（默认 localhost:3456，即 tools/cdp-proxy.mjs，
// 或任何提供同样接口的现成代理），**不自己开裸 CDP 连接** ——
// 裸连 ws://127.0.0.1:9222/devtools/browser 会触发 Chrome 的调试授权弹窗，
// 而且 Chrome 同一时间只允许一个 browser 级调试连接，会和别的自动化互相挤掉。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync, execFileSync } from 'node:child_process';

// clone 下来时 state/ logs/ 是不存在的（被 .gitignore 排除），统一在这里补上。
// 不补的话：锁文件写不进去 → kickVisible 每次静默空转 60 秒，比直接报错还难查。
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
for (const d of ['state', 'logs']) fs.mkdirSync(path.join(ROOT, d), { recursive: true });

const PROXY = process.env.CDP_PROXY || 'http://localhost:3456';

export const sleep = ms => new Promise(r => setTimeout(r, ms));

async function call(path, opts = {}) {
  const r = await fetch(PROXY + path, { ...opts, signal: AbortSignal.timeout(opts.timeoutMs || 45_000) });
  const text = await r.text();
  try { return JSON.parse(text); } catch { return { raw: text }; }
}

export const targets = () => call('/targets');
export const info = t => call(`/info?target=${t}`);
export const newTab = url => call(`/new?url=${encodeURIComponent(url)}`);
export const closeTab = t => call(`/close?target=${t}`);
export const navigate = (t, url) => call(`/navigate?target=${t}&url=${encodeURIComponent(url)}`);
export const front = t => call(`/front?target=${t}`);
export const clickAt = (t, sel) => call(`/clickAt?target=${t}`, { method: 'POST', body: sel });
export const click = (t, sel) => call(`/click?target=${t}`, { method: 'POST', body: sel });
export const screenshot = (t, file) => call(`/screenshot?target=${t}&file=${encodeURIComponent(file)}`);

export async function evalJs(t, js) {
  const r = await call(`/eval?target=${t}`, { method: 'POST', body: js });
  if (r && r.error) throw new Error('eval: ' + r.error);
  return r ? r.value : undefined;
}

// 页面里 return 的是 JSON 字符串时用这个
export async function evalJson(t, js) {
  const v = await evalJs(t, js);
  if (v == null) return null;
  return typeof v === 'string' ? JSON.parse(v) : v;
}

export async function tabAlive(t) {
  const ts = await targets();
  return Array.isArray(ts) && ts.some(x => x.targetId === t);
}

export async function findTabs(pred) {
  const ts = await targets();
  return (Array.isArray(ts) ? ts : []).filter(x => x.type === 'page' && pred(x));
}

// 让某个 tab 短暂可见，触发 Chrome 加载原生 <video>。
// 背景：Chrome 窗口被完全遮挡时所有 tab 都是 hidden，hidden tab 里 <video src=xxx.mp4>
// 会永远卡在 networkState=2 / readyState=0，一秒都不加载。/front 一次即可解锁，
// 之后转后台仍能持续 1x 播放。
//
// 同一时刻只有一个 tab 能可见，所以多个 runner 之间用文件锁串行化，避免互相抢。
// 用 fileURLToPath 而不是 URL.pathname —— 后者在含空格/中文的目录下会得到 %20 的坏路径
const LOCK = path.join(ROOT, 'state', 'front.lock');
// 把 Chrome 窗口提到前台。窗口被遮挡/最小化时，即使 tab 是"当前 tab"，
// document.visibilityState 依然是 hidden —— 而 hidden 会触发 Chrome 的密集节流，
// 把 hls.js 这类靠定时器喂数据的播放器压到 30~60% 速率。跑这套脚本的机器平时没人用时，提前台无副作用。
export function activateChrome() {
  try {
    execSync(`osascript -e 'tell application "Google Chrome" to activate'`, { stdio: 'ignore', timeout: 8000 });
    return true;
  } catch { return false; }
}

// 把"只有一个 tab、URL 含 frag"的窗口挪到指定位置。
// 用途：hzrs 每门课都会 /new 一个 class tab，Chrome 会把它扔进一个新窗口，
// 位置随机 —— 经常正好压在 163 那两个"必须保持可见"的小窗口上面，把它们变成 hidden。
// hzrs 自己不需要可见（学时按页面墙钟计，不依赖视频），所以直接挪到屏幕下方停着。
export function parkWindow(frag, [l, t, r, b]) {
  try {
    execFileSync('osascript', ['-e',
      `tell application "Google Chrome"
        repeat with i from 1 to count of windows
          if (count of tabs of window i) = 1 then
            if (URL of tab 1 of window i) contains "${frag}" then set bounds of window i to {${l}, ${t}, ${r}, ${b}}
          end if
        end repeat
      end tell`], { timeout: 15000, stdio: 'ignore' });
    return true;
  } catch { return false; }
}

// 当前哪个 tab 是可见的（只有一个）。用来在临时抢占后还回去。
export async function visibleTab() {
  const ts = await findTabs(() => true);
  for (const t of ts) {
    try { if ((await evalJs(t.targetId, 'document.visibilityState')) === 'visible') return t.targetId; } catch { }
  }
  return null;
}

export async function kickVisible(t, { waitMs = 4000, tag = '?', restore = true } = {}) {
  for (let i = 0; i < 60; i++) {
    try {
      fs.writeFileSync(LOCK, `${tag} ${Date.now()}`, { flag: 'wx' });
      break;
    } catch {
      // 锁超过 60s 视为死锁（持有者崩了），强行抢走
      try {
        const [, ts] = fs.readFileSync(LOCK, 'utf8').split(' ');
        if (Date.now() - Number(ts) > 60_000) { fs.unlinkSync(LOCK); continue; }
      } catch { }
      await sleep(1000);
    }
  }
  let prev = null;
  try {
    if (restore) prev = await visibleTab().catch(() => null);
    await front(t);
    await sleep(waitMs);
  } finally {
    // 抢完还回去：163 靠"保持可见"才能跑满速，别被别的 runner 顺手夺走
    if (restore && prev && prev !== t) { try { await front(prev); } catch { } }
    try { fs.unlinkSync(LOCK); } catch { }
  }
}

// 日志：stdout（被 nohup 重定向到 logs/）
export function makeLogger(tag) {
  return (...a) => console.log(`${new Date().toLocaleString('zh-CN')} [${tag}]`, ...a);
}

// 状态持久化
export function makeState(file) {
  let data = {};
  try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { }
  return {
    data,
    save() { try { fs.writeFileSync(file, JSON.stringify(data, null, 2)); } catch { } },
  };
}
