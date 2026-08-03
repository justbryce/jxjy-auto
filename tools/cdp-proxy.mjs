#!/usr/bin/env node
/**
 * 最小 CDP HTTP 代理 —— 把 Chrome DevTools Protocol 包成好用的 HTTP 接口。
 *
 * 为什么需要它：这套刷课脚本要接管**用户自己日常在用的那个 Chrome**（这样才天然带着各平台的登录态），
 * 而不是另起一个干净的自动化浏览器。CDP 是唯一能做到这点的通道，但它是 WebSocket 协议，
 * 而且 Chrome 只允许有限的调试连接，所以用一个常驻进程统一持有连接、对外暴露 HTTP。
 *
 * 启动前提：Chrome 开着远程调试端口。最省事的办法是在地址栏打开
 *   chrome://inspect/#remote-debugging
 * 勾选 "Allow remote debugging for this browser instance"（可能需要重启 Chrome）。
 * 或者用命令行启动：  --remote-debugging-port=9222
 *
 * 用法： node tools/cdp-proxy.mjs           # 默认监听 3456，自动探测 Chrome 端口
 *        PORT=3456 CHROME_PORT=9222 node tools/cdp-proxy.mjs
 *
 * 需要 Node 22+（用原生 WebSocket）。无第三方依赖。
 */

import http from 'node:http';
import net from 'node:net';

const PORT = Number(process.env.PORT || 3456);
const CANDIDATE_PORTS = [Number(process.env.CHROME_PORT) || 9222, 9229, 9333].filter(Boolean);

// ---------- 连接 Chrome ----------
let ws = null, chromePort = null;
let msgId = 0;
const pending = new Map();            // id -> resolve
const sessions = new Map();           // targetId -> sessionId

const probe = port => new Promise(res => {
  // 用 TCP 探测而不是直接连 WebSocket —— WebSocket 探测会被 Chrome 当成调试连接，可能弹授权框
  const s = net.createConnection(port, '127.0.0.1');
  const t = setTimeout(() => { s.destroy(); res(false); }, 1500);
  s.once('connect', () => { clearTimeout(t); s.destroy(); res(true); });
  s.once('error', () => { clearTimeout(t); res(false); });
});

async function connect() {
  if (ws && ws.readyState === 1) return;
  if (!chromePort) {
    for (const p of CANDIDATE_PORTS) if (await probe(p)) { chromePort = p; break; }
    if (!chromePort) throw new Error(`没找到 Chrome 调试端口（试过 ${CANDIDATE_PORTS.join(', ')}）。见本文件顶部注释。`);
  }
  // 两种 Chrome 的 browser 端点不一样：
  //  · 命令行 --remote-debugging-port 起的：HTTP /json/version 里有带 UUID 的 webSocketDebuggerUrl，必须用它
  //  · 在 chrome://inspect 里勾选 "Allow remote debugging" 的日常 Chrome：HTTP 端点是关的，
  //    但 ws://127.0.0.1:PORT/devtools/browser 这个无 UUID 的路径可用
  let wsUrl = `ws://127.0.0.1:${chromePort}/devtools/browser`;
  try {
    const v = await (await fetch(`http://127.0.0.1:${chromePort}/json/version`,
      { signal: AbortSignal.timeout(2000) })).json();
    if (v.webSocketDebuggerUrl) wsUrl = v.webSocketDebuggerUrl;
  } catch { /* HTTP 端点关着，用上面那个默认路径 */ }

  await new Promise((resolve, reject) => {
    ws = new WebSocket(wsUrl);
    const to = setTimeout(() => reject(new Error('连接 Chrome 超时')), 8000);
    ws.onopen = () => { clearTimeout(to); console.log(`[cdp-proxy] 已连接 Chrome :${chromePort} (${wsUrl})`); resolve(); };
    ws.onerror = e => {
      clearTimeout(to);
      reject(new Error('连接 Chrome 失败: ' + (e.message || e.error?.message || 'error') +
        '。常见原因：Chrome 同一时间只允许一个 /devtools/browser 调试连接，已经有别的工具连着了。'));
    };
    ws.onclose = () => { ws = null; sessions.clear(); };
    ws.onmessage = ev => {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    };
  });
}

function send(method, params = {}, sessionId) {
  const id = ++msgId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP 超时: ${method}`)); }, 40_000);
    pending.set(id, m => { clearTimeout(timer); m.error ? reject(new Error(m.error.message)) : resolve(m.result); });
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
}

async function attach(targetId) {
  if (sessions.has(targetId)) return sessions.get(targetId);
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
  sessions.set(targetId, sessionId);
  return sessionId;
}

async function evaluate(targetId, expression) {
  const sid = await attach(targetId);
  const r = await send('Runtime.evaluate',
    { expression, awaitPromise: true, returnByValue: true, userGesture: false }, sid);
  if (r.exceptionDetails) return { error: r.exceptionDetails.exception?.description || r.exceptionDetails.text };
  return { value: r.result?.value };
}

// 真实鼠标点击（Input.dispatchMouseEvent）—— 和 JS 的 el.click() 不同，
// 这是"可信事件"，某些站点（尤其是要用户手势才肯播放的播放器）只认这个。
async function clickAt(targetId, selector) {
  const sid = await attach(targetId);
  const box = await evaluate(targetId, `(()=>{const e=document.querySelector(${JSON.stringify(selector)});
    if(!e) return null; e.scrollIntoView({block:"center"});
    const r=e.getBoundingClientRect();
    return JSON.stringify({x:r.x+r.width/2,y:r.y+r.height/2,tag:e.tagName,w:r.width,h:r.height})})()`);
  if (!box.value) return { error: '未找到元素: ' + selector };
  const b = JSON.parse(box.value);
  for (const type of ['mousePressed', 'mouseReleased']) {
    await send('Input.dispatchMouseEvent',
      { type, x: b.x, y: b.y, button: 'left', clickCount: 1 }, sid);
  }
  return { clicked: true, x: b.x, y: b.y, tag: b.tag };
}

// ---------- HTTP ----------
const json = (res, code, obj) => {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
};
const body = req => new Promise(r => { let d = ''; req.on('data', c => d += c); req.on('end', () => r(d)); });

http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const p = u.pathname, q = u.searchParams, t = q.get('target');
  try {
    if (p === '/health') return json(res, 200, { ok: true, chromePort });
    await connect();

    if (p === '/targets') {
      const { targetInfos } = await send('Target.getTargets');
      return json(res, 200, targetInfos.filter(x => x.type === 'page'));
    }
    if (p === '/info') {
      const { targetInfos } = await send('Target.getTargets');
      const x = targetInfos.find(i => i.targetId === t);
      return json(res, 200, x ? { title: x.title, url: x.url } : {});
    }
    if (p === '/new') {
      const r = await send('Target.createTarget', { url: q.get('url') || 'about:blank' });
      return json(res, 200, { targetId: r.targetId });
    }
    if (p === '/close') { await send('Target.closeTarget', { targetId: t }); sessions.delete(t); return json(res, 200, { success: true }); }
    if (p === '/front') { await send('Target.activateTarget', { targetId: t }); return json(res, 200, { success: true }); }
    if (p === '/navigate') {
      const sid = await attach(t);
      await send('Page.navigate', { url: q.get('url') }, sid);
      return json(res, 200, { success: true });
    }
    if (p === '/eval') return json(res, 200, await evaluate(t, await body(req)));
    if (p === '/click') {
      const sel = await body(req);
      return json(res, 200, await evaluate(t, `(()=>{const e=document.querySelector(${JSON.stringify(sel)});
        if(!e) return "notfound"; e.click(); return "clicked"})()`));
    }
    if (p === '/clickAt') return json(res, 200, await clickAt(t, await body(req)));
    if (p === '/scroll') {
      const y = q.get('y') || (q.get('direction') === 'bottom' ? 999999 : 500);
      return json(res, 200, await evaluate(t, `(scrollTo(0,${Number(y)}),1)`));
    }
    if (p === '/screenshot') {
      const sid = await attach(t);
      const { data } = await send('Page.captureScreenshot', { format: 'png' }, sid);
      const file = q.get('file');
      if (file) { (await import('node:fs')).writeFileSync(file, Buffer.from(data, 'base64')); return json(res, 200, { saved: file }); }
      res.writeHead(200, { 'Content-Type': 'image/png' });
      return res.end(Buffer.from(data, 'base64'));
    }
    json(res, 404, { error: 'unknown endpoint ' + p });
  } catch (e) {
    json(res, 500, { error: String(e.message || e) });
  }
}).listen(PORT, '127.0.0.1', () => console.log(`[cdp-proxy] http://127.0.0.1:${PORT}`));
