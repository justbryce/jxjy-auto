#!/usr/bin/env node
// 学习进度汇总面板：http://localhost:8848
//
// 数字全部**现查三个平台的官方接口**，不靠本地估算（唯一例外是网易云课堂——它自己不统计学时，
// 用「已完成课时数 + 本地记账的视频时长」两个真实口径展示，并在页面上标注来源）。
// 每 60 秒自动刷新。

import http from 'node:http';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as cdp from './lib/cdp.mjs';
import { evalJson } from './lib/cdp.mjs';
import { createRequire } from 'node:module';
const require$ = createRequire(import.meta.url);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8848);
const pick = async frag => (await cdp.findTabs(t => t.url.includes(frag)))[0]?.targetId;

// ---------------- 取数 ----------------
async function zj() {
  const t = await pick('engineer.zjsjczx.org.cn');
  if (!t) throw new Error('Chrome 里没有浙江工信的页面');
  return evalJson(t, `(async()=>{const k=JSON.parse(localStorage.getItem("JEECGBOOT_PRO__PRODUCTION__3.8.3__COMMON__LOCAL__KEY__")).value.TOKEN__.value;
    const h=await (await fetch("/jeecg-boot/zg/apply/myHours?year="+new Date().getFullYear(),{headers:{"X-Access-Token":k}})).json();
    const o={gen:Number(h.result&&h.result.genclasstime)||0,ind:Number(h.result&&h.result.indclasstime)||0,types:{}};
    for(const n of [1,2,3]){
      const j=await (await fetch("/jeecg-boot/zg/student/courseware/list?pageNo=1&pageSize=500&zgcZglType="+n,{headers:{"X-Access-Token":k}})).json();
      const rs=(j.result&&j.result.records)||[];
      if(!rs.length) continue;
      const left=rs.filter(x=>x.progress<1);
      o.types[n]={all:rs.length,done:rs.length-left.length,
        hours:rs.reduce((a,b)=>a+Number(b.classtime||0),0),
        doneHours:rs.filter(x=>x.progress>=1).reduce((a,b)=>a+Number(b.classtime||0),0),
        leftSec:left.reduce((a,b)=>a+(Number(b.length)-Math.min(Number(b.longesttime||0),Number(b.length))),0),
        cur:left.filter(x=>x.progress>0).map(x=>({n:x.title,p:Math.round(x.progress*100)}))};}
    return JSON.stringify(o)})()`);
}

async function hz() {
  const t = await pick('learning.hzrs.hangzhou.gov.cn');
  if (!t) throw new Error('Chrome 里没有新干线的页面');
  return evalJson(t, `(async()=>{const p=(u,b)=>fetch(u,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(b||{})}).then(x=>x.json());
    const back=(await p("/api/index/Study.UserIndex/index")).data;
    const mine=((await p("/api/index/Course/index",{limit:200,page:1})).data.data)||[];
    const sum=t=>(back.course||[]).filter(x=>x.coursetype_text===t).reduce((a,b)=>a+Number(b.period),0);
    return JSON.stringify({
      req:(back.study||[]).map(x=>({t:x.coursetype,done:Number(x.s)||0,need:Number(x.r)||0})),
      doneN:(back.course||[]).length, zy:sum("专业课程"), hy:sum("行业公需"), yb:sum("一般公需"),
      cur:mine.map(x=>({n:x.coursename,p:Math.round(x.validstudytime/x.coursetimes*100),t:x.coursetype_text}))})})()`);
}

async function nc() {
  const t = await pick('study.163.com');
  if (!t) throw new Error('Chrome 里没有网易云课堂的页面');
  const api = await evalJson(t, `(async()=>{const tk=(document.cookie.match(/(?:^|;\\s*)NTESSTUDYSI=([^;]+)/)||[])[1]||"";
    const out=[];
    for(let p=1;p<=10;p++){
      const r=await fetch("/j/my/courseListV2.json?pageSize=20&pageIndex="+p+"&keyword=&filterType=0&t="+Date.now(),
        {headers:{"edu-script-token":tk,"Accept":"application/json"}});
      if(!r.ok) return JSON.stringify({err:r.status});
      const j=await r.json();
      if(j&&(j.code===-2||j.message==="not_auth")) return JSON.stringify({err:"登录态失效（not_auth），请在 Chrome 里重新登录 study.163.com"});
      const L=(j.result&&j.result.list)||[];
      out.push(...L.map(x=>({id:String(x.courseId),name:x.name,units:x.units,fin:x.finishedUnits})));
      if(p>=((j.result&&j.result.query&&j.result.query.totlePageCount)||1))break;}
    return JSON.stringify({list:out})})()`);
  if (api?.err) throw new Error('接口 ' + api.err + '（登录态？）');
  let watched = {};
  try { watched = JSON.parse(fs.readFileSync(path.join(HERE, 'state/study163.json'), 'utf8')).watched || {}; } catch { }
  const secs = Object.values(watched).reduce((a, b) => a + (b.s || 0), 0);
  return { list: api.list, watchedSecs: secs, watchedN: Object.keys(watched).length };
}

// 把日志尾巴翻译成人话：现在在学哪门、进度多少、速率正不正常。
// 原始日志留在下面折叠，出问题时才需要看。
const NAME = { zjsjczx: '浙江工信', hzrs: '新干线', study163: '网易云课堂' };

function parseActivity(site, lines) {
  const L = lines.slice(-200);
  const last = re => { for (let i = L.length - 1; i >= 0; i--) { const m = L[i].match(re); if (m) return m; } return null; };

  if (site === 'zjsjczx') {
    const c = last(/▶ 《(.+?)》.*?(\d+(?:\.\d+)?)学时/);
    const p = last(/\s(\d+)%\s+(\d+)\/(\d+)s\s*$/);
    if (!c) return null;
    return [{ what: `《${c[1]}》 ${c[2]}学时`,
              how: p ? `视频 ${p[1]}%（${p[2]}/${p[3]}秒）` : '起播中…' }];
  }

  if (site === 'hzrs') {
    const c = last(/▶ 《(.+?)》.*?(\d+(?:\.\d+)?)学时 需 (\d+)分钟/);
    const p = last(/\s(\d+)%\s+(\d+)\/(\d+)s（本次/);
    if (!c) return null;
    return [{ what: `《${c[1]}》 ${c[2]}学时`,
              how: p ? `已计时 ${p[1]}%（${p[2]}/${p[3]}秒）` : `需 ${c[3]} 分钟，刚开始` }];
  }

  // 163 按 worker 分开。日志格式：  w0 ▶ 《课程名》 课时1 课时名 08:30
  // （早期是「▶ 课时1 《课时名》」，改成按课时分派队列后课程名挪到了前面 —— 两种都兼容一下）
  const out = [];
  for (const w of ['w0', 'w1', 'w2', 'w3', 'w4', 'w5']) {
    const cNew = last(new RegExp(`${w} ▶ 《(.+?)》\\s*(课时\\d+)\\s*(.*)$`));
    const cOld = cNew ? null : last(new RegExp(`${w} ▶ (课时\\d+) 《(.+?)》`));
    if (!cNew && !cOld) continue;
    const what = cNew
      ? `《${cNew[1]}》 ${cNew[2]} ${String(cNew[3] || '').replace(/\s*\d+:\d+\s*$/, '')}`
      : `${cOld[1]} ${cOld[2]}`;
    const p = last(new RegExp(`${w}\\s+(\\d+)%\\s+(\\d+)/(\\d+)s\\s+速率(\\d+)%`));
    out.push({
      w, what: what.trim(),
      how: p ? `${p[1]}%（${p[2]}/${p[3]}秒）` : '起播中…',
      rate: p ? Number(p[4]) : null,
    });
  }
  return out.length ? out : null;
}

function runners() {
  const { execSync } = require$('node:child_process');
  return ['zjsjczx', 'hzrs', 'study163'].map(s => {
    let alive = false, tail = '', lines = [];
    try { execSync(`pgrep -f "runners/${s}.mjs"`, { stdio: 'ignore' }); alive = true; } catch { }
    try {
      lines = fs.readFileSync(path.join(HERE, `logs/${s}.log`), 'utf8').trim().split('\n');
      tail = lines.slice(-12).join('\n');
    } catch { }
    // 最近 30 分钟里的真故障（自愈类的不算）
    const bad = lines.slice(-200).filter(x => /💥|❌|计时卡住|本轮异常|启动失败|未识别弹窗|登录态|读不到/.test(x)).slice(-3);
    return { s, name: NAME[s], alive, tail, act: parseActivity(s, lines), bad };
  });
}
// ---------------- 渲染 ----------------
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const hrs = s => (s / 3600).toFixed(1);

function bar(done, need, color) {
  const pct = need > 0 ? Math.min(100, done / need * 100) : (done > 0 ? 100 : 0);
  return `<div class="bar"><i style="width:${pct.toFixed(1)}%;background:${color}"></i></div>`;
}

function render(d) {
  const t = new Date().toLocaleString('zh-CN');
  const TN = { 1: '专业科目', 2: '一般公需', 3: '行业公需' };

  let zjHtml;
  if (d.zj.err) zjHtml = `<p class="err">${esc(d.zj.err)}</p>`;
  else {
    const z = d.zj.v;
    const rows = Object.entries(z.types).map(([n, x]) => `<tr>
      <td>${TN[n]}</td><td>${x.done}/${x.all} 门</td><td>${x.doneHours.toFixed(1)}/${x.hours.toFixed(1)} 学时</td>
      <td>${bar(x.doneHours, x.hours, '#4c8bf5')}</td><td class="dim">剩 ${hrs(x.leftSec)} 小时视频</td></tr>`).join('');
    zjHtml = `<div class="kpi"><b>${(z.gen + z.ind).toFixed(1)}</b><span>已获学时（一般公需 ${z.gen} + 行业公需 ${z.ind}）</span></div>
      <table>${rows}</table>
      <p class="note">口径：平台接口 <code>/zg/apply/myHours</code> + 课件列表 <code>progress</code>，实时。</p>`;
  }

  let hzHtml;
  if (d.hz.err) hzHtml = `<p class="err">${esc(d.hz.err)}</p>`;
  else {
    const h = d.hz.v;
    const rows = h.req.map(r => `<tr><td>${esc(r.t)}</td><td>${r.done}/${r.need || '—'} 学时</td>
      <td>${bar(r.done, r.need, '#e0762a')}</td></tr>`).join('');
    const cur = h.cur.length ? `<ul class="cur">${h.cur.map(c => `<li>${esc(c.n)} <b>${c.p}%</b> <span class="tag">${esc(c.t)}</span></li>`).join('')}</ul>` : '<p class="dim">（无进行中的课）</p>';
    const total = h.req.find(x => x.t === '总学时');
    hzHtml = `<div class="kpi"><b>${(total?.done ?? 0).toFixed(1)}</b><span>官方已计入学时 / 年度要求 ${total?.need ?? 90}</span></div>
      <table>${rows}</table>
      <p class="note">⚠️ 平台的「已学课程」接口只返回最近 8 条（不是全量），所以别用它加总来估学时；
      上面这个大数字取的是平台自己算好的官方计入数，才是准的。<br>
      <b>学完不会自动结算</b> —— 必须在后台点「学时重算」（每天限 3 次），
      已自动化为每天 08:05 / 20:05 各一次，所以它会滞后于上面那个实时数。手动催：<code>node recalc.mjs</code>。<br>
      年度要求：总 90（专业课程 60，公需合计 ≥18）。<b>浙江工信的学时不会流进来</b>，18 公需学时得在本站自己刷。</p>
      <h4>进行中</h4>${cur}`;
  }

  let ncHtml;
  if (d.nc.err) ncHtml = `<p class="err">${esc(d.nc.err)}</p>`;
  else {
    const n = d.nc.v;
    const units = n.list.reduce((a, b) => a + b.units, 0), fin = n.list.reduce((a, b) => a + b.fin, 0);
    const rows = n.list.map(c => `<tr><td>${esc(c.name)}</td><td>${c.fin}/${c.units} 课时</td>
      <td>${bar(c.fin, c.units, '#c8443c')}</td></tr>`).join('');
    ncHtml = `<div class="kpi"><b>${fin}/${units}</b><span>课时（本机记账已看完 ${n.watchedN} 个课时 / ${hrs(n.watchedSecs)} 小时视频）</span></div>
      <table>${rows}</table>
      <p class="note">网易云课堂<b>没有"学时"这个概念</b>，也没有任何官方学时统计页。这里给两个都能核对的真实口径：<br>
      ① 课时完成数 —— 平台接口 <code>/j/my/courseListV2.json</code> 的 <code>finishedUnits/units</code>，可在「我的学习」页面肉眼核对；<br>
      ② 视频时长 —— 本机记录每个播完的课时的实际 <code>video.duration</code> 累加，不含重播。</p>`;
  }

  const rs = d.runners.map(r => {
    const act = (r.act || []).map(a => {
      const slow = a.rate != null && a.rate < 70;
      return `<div class="act"><div class="aw">${a.w ? `<span class="wk">${a.w}</span>` : ''}${esc(a.what)}</div>
        <div class="ah">${esc(a.how)}${a.rate != null ? ` · <span class="${slow ? 'slow' : 'okr'}">速率 ${a.rate}%</span>` : ''}</div></div>`;
    }).join('') || '<div class="dim">（还没开始）</div>';
    const bad = r.bad?.length
      ? `<div class="bad">最近异常：<br>${r.bad.map(x => esc(x.replace(/^\S+ \S+ /, ''))).join('<br>')}</div>` : '';
    return `<div class="r ${r.alive ? 'on' : 'off'}">
      <b>${r.name}</b> <span class="dim">${r.alive ? '运行中' : '已停止'}</span>
      ${act}${bad}
      <details><summary>原始日志</summary><pre>${esc(r.tail)}</pre></details></div>`;
  }).join('');

  return `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>继续教育学习进度</title>
<meta http-equiv="refresh" content="60">
<style>
:root{--bg:#fafafa;--fg:#1a1a1a;--card:#fff;--line:#e6e6e6;--dim:#888}
@media(prefers-color-scheme:dark){:root{--bg:#141414;--fg:#e8e8e8;--card:#1e1e1e;--line:#2e2e2e;--dim:#999}}
*{box-sizing:border-box}
body{margin:0;padding:24px;background:var(--bg);color:var(--fg);
 font:15px/1.6 -apple-system,BlinkMacSystemFont,"PingFang SC","Helvetica Neue",sans-serif}
h1{font-size:20px;margin:0 0 4px}
.sub{color:var(--dim);font-size:13px;margin-bottom:20px}
.grid{display:grid;gap:16px;grid-template-columns:repeat(auto-fit,minmax(340px,1fr))}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:18px}
.card h2{font-size:15px;margin:0 0 14px;display:flex;align-items:center;gap:8px}
.card h2 em{font-style:normal;font-size:12px;color:var(--dim);font-weight:400}
.kpi{margin-bottom:14px}
.kpi b{font-size:30px;font-variant-numeric:tabular-nums;display:block;line-height:1.1}
.kpi span{font-size:12px;color:var(--dim)}
table{width:100%;border-collapse:collapse;font-size:13px}
td{padding:5px 8px 5px 0;vertical-align:middle}
td:first-child{white-space:nowrap;color:var(--dim)}
td:nth-child(2){white-space:nowrap;font-variant-numeric:tabular-nums}
.bar{height:6px;background:var(--line);border-radius:3px;overflow:hidden;min-width:70px}
.bar i{display:block;height:100%;border-radius:3px}
.dim{color:var(--dim);font-size:12px}
.note{font-size:11.5px;color:var(--dim);margin:12px 0 0;line-height:1.7}
code{background:var(--line);padding:1px 4px;border-radius:3px;font-size:11px}
h4{font-size:12px;color:var(--dim);margin:14px 0 6px;font-weight:600}
ul.cur{margin:0;padding-left:16px;font-size:13px}
ul.cur li{margin:3px 0}
.tag{font-size:11px;color:var(--dim);border:1px solid var(--line);border-radius:4px;padding:0 4px}
.err{color:#c8443c;font-size:13px}
.runners{margin-top:20px;display:grid;gap:10px;grid-template-columns:repeat(auto-fit,minmax(300px,1fr))}
.r{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px}
.r b{font-size:13px}.r.on b::before{content:"● ";color:#3aa657}.r.off b::before{content:"● ";color:#c8443c}
.r pre{margin:8px 0 0;font-size:10.5px;color:var(--dim);white-space:pre-wrap;word-break:break-all;overflow-x:auto}
.act{margin:8px 0 0;padding-left:10px;border-left:2px solid var(--line)}
.aw{font-size:13px;line-height:1.45}
.ah{font-size:12px;color:var(--dim);font-variant-numeric:tabular-nums}
.wk{display:inline-block;min-width:24px;font-size:11px;color:var(--dim)}
.okr{color:#3aa657}.slow{color:#e0762a}
.bad{margin-top:10px;font-size:11px;color:#c8443c;line-height:1.6;word-break:break-all}
details{margin-top:10px}
summary{font-size:11px;color:var(--dim);cursor:pointer}
</style></head><body>
<h1>继续教育学习进度</h1>
<div class="sub">${t} · 每 60 秒自动刷新 · 数据现查平台接口</div>
<div class="grid">
  <div class="card"><h2>浙江工信继续教育 <em>engineer.zjsjczx.org.cn</em></h2>${zjHtml}</div>
  <div class="card"><h2>杭州学习新干线 <em>learning.hzrs.hangzhou.gov.cn</em></h2>${hzHtml}</div>
  <div class="card"><h2>网易云课堂 <em>study.163.com</em></h2>${ncHtml}</div>
</div>
<div class="runners">${rs}</div>
</body></html>`;
}

// ---------------- 服务 ----------------
const wrap = async fn => { try { return { v: await fn() }; } catch (e) { return { err: e.message }; } };

const handler = async (req, res) => {
  if (req.url === '/favicon.ico') { res.writeHead(204).end(); return; }
  const [z, h, n] = await Promise.all([wrap(zj), wrap(hz), wrap(nc)]);
  const data = { zj: z, hz: h, nc: n, runners: runners() };
  if (req.url.startsWith('/json')) {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(data, null, 2));
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(render(data));
};

// 本机 + Tailscale 各监听一份：手机在 Tailscale 网络里也能看。
// 不绑 0.0.0.0 —— 免得整个家庭 WiFi 都能访问。
// 默认**只监听 127.0.0.1**。面板上有你的课程名和学习进度，不该在局域网里裸奔。
// 想让手机/别的机器看，显式设 EXPOSE=lan（额外绑 192.168./10./100. 这些内网地址）
// 或 EXPOSE=<具体IP>。注意本服务没有任何鉴权。
// 小提醒：如果访问方开着系统代理（Clash 之类），发往 100.64/10 的请求可能被代理吃掉返回 5xx，
// 表现为"该网页无法正常运作" —— 那是 5xx 不是连不上，把该网段加进代理 bypass 即可。
const HOSTS = ['127.0.0.1'];
const EXPOSE = process.env.EXPOSE || '';
if (EXPOSE === 'lan') {
  try {
    for (const a of Object.values(os.networkInterfaces()).flat()) {
      if (!a || a.family !== 'IPv4' || a.internal) continue;
      if (/^(100\.|192\.168\.|10\.)/.test(a.address)) HOSTS.push(a.address);
    }
  } catch { }
} else if (EXPOSE) {
  HOSTS.push(...EXPOSE.split(',').map(x => x.trim()).filter(Boolean));
}

for (const h of HOSTS) {
  const srv = http.createServer(handler);
  srv.on('error', e => console.log(`绑定 ${h}:${PORT} 失败: ${e.message}`));
  srv.listen(PORT, h, () => console.log(`面板已启动: http://${h}:${PORT}  (JSON: /json)`));
}
