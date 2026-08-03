#!/usr/bin/env node
// 站点 2：杭州市专业技术人员学习新干线（learning.hzrs.hangzhou.gov.cn）
//
// 机制（已实测）：
//  - 学时按「#/class 页面开着的墙钟时间」累计：页面每 30~60s POST /api/index/Study.Index/updateStudy
//    {courseId,delay:1200,logId,sign}，服务端按两次请求之间的真实间隔给 playTime 加秒。
//    sign 是滚动令牌（上一次响应的 sign 作为下一次请求的 sign），由页面自己维护，我们不碰。
//  - 完成条件：validstudytime >= coursetimes。
//  - ⚠️ 平台强制「同一时间只能学一门课」，开第二门会把第一门踢掉 → 本 runner 严格串行，
//    且发现有别人（比如你自己手动）开着 class 页时会让路。
//  - 必须先「选课」（chooseCourse）课程才会进「我的网络课程」，才能学。
//
// 学习顺序：专业课程(工学) → 专业课程(其他) → 行业公需 → 一般公需
// 年度要求：总 90 学时，其中专业课程 60、公需合计 ≥18。

import * as cdp from '../lib/cdp.mjs';
import { sleep, evalJs, evalJson } from '../lib/cdp.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ORIGIN = 'https://learning.hzrs.hangzhou.gov.cn';
const POLL = 30_000;
// 默认 **不** 播视频：本站学时按「课程页开着的墙钟时间」计，播视频对学时零收益，
// 反而会跟另外两个必须真播的站抢带宽和「可见窗口」槽位。要播就 HZ_PLAY_VIDEO=1。
const PLAY_VIDEO = process.env.HZ_PLAY_VIDEO === '1';
const log = cdp.makeLogger('hz');
const state = cdp.makeState(path.join(HERE, '../state/hzrs.json'));

// 课程类别 typeid：15 专业课程 / 16 行业公需 / 17 一般公需
const TYPE_ORDER = [15, 16, 17];
const TYPE_NAME = { 15: '专业课程', 16: '行业公需', 17: '一般公需' };
// 专业课程里优先哪个学科门类，按自己的专业领域改（这里是工学=工信领域）
const SYSTEM_PRIORITY = { '工学': 0, '理学': 1, '经济学': 2 };
// 公需（行业+一般）要先攒够这么多学时，再去刷专业课程（年度硬性要求是 ≥18，留点余量）
const GX_TARGET = Number(process.env.HZ_GX_TARGET || 20);

async function post(target, url, body) {
  return evalJson(target, `(async()=>{const r=await fetch(${JSON.stringify(url)},{method:"POST",
    headers:{"Content-Type":"application/json"},body:${JSON.stringify(JSON.stringify(body))}});
    return JSON.stringify(await r.json())})()`);
}

// ---- 控制 tab（只用来打接口，不播课） ----
async function ensureCtl() {
  if (state.data.ctl && await cdp.tabAlive(state.data.ctl)) return state.data.ctl;
  const r = await cdp.newTab(ORIGIN + '/#/Learn');
  state.data.ctl = r.targetId; state.save();
  log('新建控制 tab', r.targetId);
  // 等页面真的落到本站再用它打接口 —— 还停在 about:blank 时相对路径 fetch 会打到错误的 origin
  for (let i = 0; i < 12; i++) {
    await sleep(2000);
    const u = await cdp.info(r.targetId).then(x => x?.url || '').catch(() => '');
    if (u.includes('learning.hzrs.hangzhou.gov.cn')) break;
  }
  await sleep(3000);
  return r.targetId;
}

async function catalog(ctl, type) {
  const out = [];
  for (let p = 1; p <= 60; p++) {
    const j = await post(ctl, '/api/index/index/SelectCourse', { limit: 100, page: p, type });
    if (!j?.course) break;
    out.push(...j.course.data);
    if (j.course.current_page >= j.course.last_page) break;
  }
  return out.map(c => ({
    id: String(c.courseid), name: c.coursename, h: +c.period || 0,
    secs: +c.coursetimes || 0, sys: c.min_catelogname || '', cat: c.catelogname || '', type,
  }));
}

async function myCourses(ctl) {
  const j = await post(ctl, '/api/index/Course/index', { limit: 200, page: 1 });
  return (j?.data?.data || []).map(x => ({
    id: String(x.courseid), name: x.coursename, vst: +x.validstudytime || 0,
    secs: +x.coursetimes || 0, h: +x.period || 0, type: x.coursetype_text,
  }));
}

// 已学完的课程（学完后会从「我的网络课程」移出，只在学时后台的已学课程里）。
// 不排除它们的话，会被目录里重新选回来无限重学。同时统计各类别已拿到的学时。
async function finished(ctl) {
  const j = await post(ctl, '/api/index/Study.UserIndex/index', {});
  const list = (j?.data?.course) || [];
  const hours = {};
  for (const x of list) hours[x.coursetype_text] = (hours[x.coursetype_text] || 0) + (+x.period || 0);
  return { ids: new Set(list.map(x => String(x.courseid))), hours };
}

async function chooseCourse(ctl, ids) {
  const r = await post(ctl, '/api/index/Course/chooseCourse', { courseid: ids });
  return r?.status === 200;
}

// ---- 别人在学吗 ----
async function foreignClassTab(mine) {
  const ts = await cdp.findTabs(t => t.url.includes('learning.hzrs.hangzhou.gov.cn/#/class'));
  return ts.find(t => t.targetId !== mine) || null;
}

// ---- 播课 ----
async function openClass(courseId) {
  if (state.data.cls && await cdp.tabAlive(state.data.cls)) await cdp.closeTab(state.data.cls);
  const r = await cdp.newTab(`${ORIGIN}/#/class?courseId=${courseId}`);
  state.data.cls = r.targetId; state.save();
  await sleep(7000);
  // Chrome 常把新 tab 扔进一个位置随机的新窗口，容易压住 163 那两个必须保持可见的小窗口。
  // 本站不需要可见（学时按页面墙钟计），挪到屏幕下方停着。
  cdp.parkWindow('#/class?courseId=', [0, 620, 700, 1060]);
  return r.targetId;
}

// 页面里装个钩子，抓 updateStudy 的 playTime / finish，用来判断"计时到底有没有在走"
const HOOK = `(()=>{if(window.__hk)return "y";window.__hk=1;window.__pt=null;window.__fin=0;window.__last=0;
const ox=XMLHttpRequest.prototype.open,os=XMLHttpRequest.prototype.send;
XMLHttpRequest.prototype.open=function(m,u){this.__u=String(u);return ox.apply(this,arguments)};
XMLHttpRequest.prototype.send=function(b){const x=this;x.addEventListener("load",()=>{
 if(/updateStudy/.test(x.__u||"")){try{const j=JSON.parse(x.responseText);
  if(j&&j.data){window.__pt=j.data.playTime;window.__fin=j.data.finish;window.__last=Date.now()}}catch(e){}}});
return os.apply(this,arguments)};return "ok"})()`;

// ⚠️ 绝对不要在 eval 里 `await v.play()`：视频加载不动时那个 Promise 永远不 settle，
//    CDP Runtime.evaluate 会挂到超时（45s）再抛异常。一律 fire-and-forget，之后再读状态。
const KICK = `(()=>{const v=document.querySelector("video");
  if(!v) return JSON.stringify({none:true});
  v.muted=false;v.volume=0;v.playbackRate=1;
  try{const p=v.play();if(p&&p.catch)p.catch(e=>{window.__playErr=e.name})}catch(e){window.__playErr=e.name}
  return JSON.stringify({kicked:1})})()`;

const VSTAT = `(()=>{const v=document.querySelector("video");
  if(!v) return JSON.stringify({none:true});
  return JSON.stringify({paused:v.paused,ready:v.readyState,dur:v.duration,
    src:(v.currentSrc||v.src||"").slice(0,120),err:window.__playErr||null})})()`;

async function startVideo(target) {
  if (!PLAY_VIDEO) return null;
  // 部分课件不是 mp4（老课是 iframe 里的 html 课件），<video> 压根没 src。
  // 这种就别去抢 /front 了 —— 学时本来也不依赖视频播放。
  const probe = await evalJson(target, VSTAT).catch(() => null);
  if (!probe || probe.none || !probe.src) return probe;

  let s = null;
  for (let i = 0; i < 2; i++) {
    // 隐藏 tab 里原生 <video src=*.mp4> 一秒都不加载，必须 /front 一下踢它
    await cdp.kickVisible(target, { waitMs: 4500, tag: 'hz' });
    // video.js 皮肤：优先点大播放按钮，拿到的用户手势更可靠
    await cdp.clickAt(target, '.vjs-big-play-button').catch(() => { });
    await evalJs(target, `(()=>{const v=document.querySelector("video");if(v)v.id="__pv";return 1})()`).catch(() => { });
    await cdp.clickAt(target, '#__pv').catch(() => { });
    await evalJs(target, KICK).catch(() => { });
    await sleep(3000);
    s = await evalJson(target, VSTAT).catch(() => null);
    if (s && !s.none && s.ready >= 2) break;
  }
  return s;
}

async function classState(target) {
  return evalJson(target, `(()=>{const v=document.querySelector("video");
    return JSON.stringify({pt:window.__pt,fin:window.__fin,last:window.__last,url:location.href,
      cur:v?v.currentTime:null,dur:v?v.duration:null,paused:v?v.paused:null,ready:v?v.readyState:null,
      dlg:(document.querySelector(".el-message-box__message,.el-message__content")||{}).innerText||null})})()`);
}

// 🔑 有历史进度的课程一打开就弹「是否继续学习？」，**不点掉计时器根本不启动**（updateStudy 一次都不发）。
// 完成时也会弹「您的学习时间已达到要求，获得学分:X,是否继续学习?」，那个别点确定（会重新开始学同一门）。
async function dismissDialog(target) {
  return evalJson(target, `(()=>{const b=document.querySelector(".el-message-box");
    if(!b) return JSON.stringify({none:true});
    const txt=(b.innerText||"").replace(/\\s+/g," ").trim();
    if(/获得学分|已达到要求/.test(txt)) return JSON.stringify({finished:true,txt});
    const ok=[...b.querySelectorAll("button")].find(x=>/^(确定|继续|是|确认)$/.test((x.innerText||"").trim()));
    if(ok){ok.click();return JSON.stringify({clicked:true,txt})}
    return JSON.stringify({stuck:true,txt})})()`).catch(() => null);
}

async function learn(ctl, c, already) {
  const need = c.secs - already;
  const tStart = Date.now();
  log(`▶ 《${c.name}》 id=${c.id} ${c.h}学时 需 ${Math.round(c.secs / 60)}分钟，已计 ${Math.round(already / 60)}分钟`);

  const tab = await openClass(c.id);
  await evalJs(tab, HOOK).catch(() => { });
  // 开局先把「是否继续学习？」点掉，否则计时器不启动
  for (let i = 0; i < 5; i++) {
    const d = await dismissDialog(tab);
    if (d?.clicked) { log('  点掉弹窗：', d.txt.slice(0, 40)); break; }
    if (d?.none) break;
    await sleep(2000);
  }
  const v = await startVideo(tab).catch(e => { log('  起播异常（不影响计时）:', e.message); return null; });
  if (!PLAY_VIDEO) log('  未开启视频播放（HZ_PLAY_VIDEO≠1），只靠页面计时 —— 本站学时本来就不看视频');
  else if (!v || v.none) log('  该课件没有 <video>（html 课件），只靠页面计时');
  else if (!v.src) log('  <video> 无 src（html 课件），只靠页面计时');
  else log(`  视频: ready=${v.ready} paused=${v.paused} ${v.err || ''}`);

  const t0 = Date.now(), budget = (need + 900) * 1000;
  let lastPt = -1, stall = 0, dlgLoggedAt = 0;
  while (Date.now() - t0 < budget) {
    await sleep(POLL);

    if (!await cdp.tabAlive(tab)) { log('  class tab 被关掉了（多半是被平台踢了），重开'); return 'retry'; }
    let s;
    try { s = await classState(tab); } catch (e) { log('  轮询失败', e.message); continue; }
    if (!s) continue;
    if (s.dlg) {
      const d = await dismissDialog(tab);
      if (d?.finished) { log('  ✓ 平台判定完成:', d.txt.slice(0, 60)); return 'done'; }
      // 有的课点了「确定」弹窗也不消失（真实鼠标点击一样），但计时照常走 —— 属无害常驻弹窗，
      // 每 5 分钟才记一次，别刷屏盖住真问题。
      if (Date.now() - dlgLoggedAt > 300_000) {
        dlgLoggedAt = Date.now();
        log(d?.clicked ? '  弹窗（已点确定）：' : '  ⚠ 未识别弹窗：', String(d?.txt || s.dlg).slice(0, 60));
      }
    }
    if (!String(s.url).includes(`courseId=${c.id}`)) { log('  页面跳走了'); return 'retry'; }

    if (s.fin === 1) { log('  ✓ 平台判定完成'); return 'done'; }

    // ⚠️ updateStudy 返回的 playTime 是**本次会话**的秒数（每次开页面新建 logId 从 0 起），
    //    累计值是接口里的 validstudytime。所以判完成要用 已计 + 本次。
    if (s.pt != null && s.pt !== lastPt) {
      stall = 0;
      const total = already + s.pt;
      const pct = Math.min(100, Math.round(total / c.secs * 100));
      if (Math.floor(pct / 10) !== Math.floor(Math.min(100, (already + lastPt) / c.secs * 100) / 10))
        log(`  ${pct}%  ${total}/${c.secs}s（本次 ${s.pt}s）`);
      lastPt = s.pt;
      if (total >= c.secs) { log('  ✓ 时长已够'); return 'done'; }
    } else if (++stall >= 4) {
      log(`  计时卡住 2 分钟（playTime=${s.pt}），重开页面`);
      return 'retry';
    }

    // 视频掉了就悄悄拉起来，但不强求（学时不依赖视频）
    if (PLAY_VIDEO && s.paused && s.ready >= 2) await evalJs(tab, KICK).catch(() => { });
  }
  log('  超时');
  return 'timeout';
}

async function main() {
  while (true) {
    try {
      if (await loop() === 'finished') { log('收工，退出'); return; }
    } catch (e) { log('⚠ 本轮异常，30 秒后继续:', e.message); await sleep(30_000); }
  }
}

async function loop() {
  const ctl = await ensureCtl();
  let repeatId = null, repeatN = 0;   // 兜底：同一门课连续开太多次 = 死循环

  while (true) {
    // 让路：用户自己在学就别抢
    const foreign = await foreignClassTab(state.data.cls);
    if (foreign) {
      log('检测到另一个 class 页面在开着（应该是用户本人在学），等 5 分钟');
      if (state.data.cls && await cdp.tabAlive(state.data.cls)) { await cdp.closeTab(state.data.cls); state.data.cls = null; state.save(); }
      await sleep(300_000);
      continue;
    }

    const mine = await myCourses(ctl);
    if (!mine) { log('❌ 接口失败（登录态可能过期），10 分钟后重试'); await sleep(600_000); continue; }

    // 严格按 专业课程 → 行业公需 → 一般公需 的顺序决策：
    // 先看这一类在「我的网络课程」里有没有没学完的，没有就从目录里新选一门。
    // （不能简单地"先清空我的网络课程"—— 那样以前误选的一般公需会插到专业课程前面。）
    const black = new Set(state.data.blacklist || []);
    const pending = mine.filter(x => x.vst < x.secs - 5 && !black.has(x.id));
    const fin = await finished(ctl);
    const doneSet = new Set([...mine.map(x => x.id), ...fin.ids, ...black]);
    let pick = null, already = 0;

    // 年度要求：总 90 = 专业课程 60 + 公需（行业+一般）≥18。
    // 公需那部分学时通常**必须在本站拿**（「获取继教基地学时」按钮多数账号点了没反应，
    //    别的平台的学时不会自动流过来 —— 用你自己的账号确认一下），
    // 而专业课程有 339 门要刷，不先把公需拿掉的话永远轮不到它 → 公需没够就先刷公需。
    const gxDone = (fin.hours['行业公需'] || 0) + (fin.hours['一般公需'] || 0)
      + pending.filter(x => x.type === '行业公需' || x.type === '一般公需').reduce((a, b) => a + (b.vst >= b.secs - 5 ? b.h : 0), 0);
    const order = gxDone < GX_TARGET ? [16, 17, 15] : TYPE_ORDER;
    if (gxDone < GX_TARGET) log(`公需 ${gxDone.toFixed(1)}/${GX_TARGET} 学时，先补公需`);

    for (const type of order) {
      const inProgress = pending.filter(x => x.type === TYPE_NAME[type])
        .sort((a, b) => (b.vst / b.secs) - (a.vst / a.secs));   // 快学完的先收尾
      if (inProgress.length) { pick = inProgress[0]; already = pick.vst; break; }

      const list = (await catalog(ctl, type)).filter(x => !doneSet.has(x.id) && x.secs > 0 && x.h > 0);
      if (!list.length) continue;
      list.sort((a, b) =>
        (SYSTEM_PRIORITY[a.sys] ?? 9) - (SYSTEM_PRIORITY[b.sys] ?? 9) ||   // 工学优先
        a.secs / a.h - b.secs / b.h);                                      // 再按每学时耗时最短
      const cand = list[0];
      if (!await chooseCourse(ctl, [cand.id])) { log('选课失败', cand.id); await sleep(60_000); break; }
      log(`＋ 选课《${cand.name}》 ${cand.h}学时 [${cand.sys}/${cand.cat}]（${TYPE_NAME[type]}还剩 ${list.length} 门）`);
      pick = { id: cand.id, name: cand.name, secs: cand.secs, h: cand.h };
      already = 0;
      break;
    }
    if (!pick && pending.length) { pick = pending[0]; already = pick.vst; }   // 兜底：类型名对不上的
    if (!pick) {
      // ⚠️ 「目录接口一门都没返回」≠「真的学完了」。控制 tab 刚建出来还没加载完时，
      //    同源 fetch 会失败/返回空，误判成 finished 就直接退出进程了（踩过）。
      //    真的学完的判据是：目录里确实有课，只是全都在已完成集合里。
      const probe = await catalog(ctl, 15);
      if (!probe.length) { log('❌ 目录接口没返回任何课程（页面没加载好？登录态？），2 分钟后重试'); await sleep(120_000); continue; }
      log('🎉 没有可学的课了');
      return 'finished';
    }

    // 兜底防死循环：同一门课连续被选中 5 次还没进展，直接拉黑
    if (pick.id === repeatId) { repeatN++; } else { repeatId = pick.id; repeatN = 1; }
    if (repeatN > 5) {
      log(`  ⛔ 《${pick.name}》 连续开了 ${repeatN} 次仍无进展，拉黑`);
      (state.data.blacklist ||= []).push(pick.id); state.save();
      repeatId = null; repeatN = 0;
      continue;
    }

    const t0 = Date.now();
    const r = await learn(ctl, pick, already);
    const spent = (Date.now() - t0) / 1000;
    if (r === 'done') {
      const after = (await myCourses(ctl)).find(x => x.id === pick.id);
      if (!after) {
        log(`  ✅ 《${pick.name}》 完成（已移出我的网络课程）`);
        state.data.doneCount = (state.data.doneCount || 0) + 1;
      } else if (spent < (pick.secs - already) * 0.5) {
        // 平台秒判 finish=1（远不到该课需要的时长），而 validstudytime 纹丝不动 ——
        // 这门课其实早就拿过学分了，只是被重新选课生成了一条 vst=0 的新记录。
        // 不拉黑的话会一分钟一轮无限重开（实测能这么空转好几个小时）。
        // 注意：validstudytime 不是实时更新的（学习中查到的常常还是 0），
        // 所以判据只能用「用时远小于应需时长」，不能用 vst 有没有涨。
        log(`  ⛔ 只用了 ${Math.round(spent)}s 平台就判完成（该课需 ${pick.secs}s），说明早已拿过学分，拉黑不再选`);
        (state.data.blacklist ||= []).push(pick.id);
      } else {
        log(`  → 本轮学满 ${Math.round(spent)}s，validstudytime=${after.vst}/${after.secs}，下轮继续`);
      }
    }
    state.data.lastId = pick.id; state.save();
    await sleep(8000);
  }
}

main().catch(e => { log('💥', e.stack); process.exit(1); });
