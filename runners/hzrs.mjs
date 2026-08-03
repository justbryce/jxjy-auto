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
// 学习顺序：**不要硬编码**，读平台后台自己给的年度要求（`data.study` 里每类的 r/s，见 finished()）。
// 谁还差就先补谁；硬性要求都满了再拿没有下限的类别去填总学时。
// （这个账号 2026 年是：专业课程 60 / 行业公需 0 / 一般公需 0 / 总学时 90，
//   别的账号未必一样，所以只能现查。）

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

// 🔑「专业方向」的权威字段是 professional_field_id（专业领域/行业系列），
//    **不是** min_catelogname（学科门类，列表卡片上那个 [工学] 角标）—— 两者完全正交。
//    9 = 工业和信息化领域系列。改成你自己申报的方向，或设成空串关掉校验。
//
//    重要：`SelectCourse` 返回的课程池**服务端已经按账号申报的专业领域过滤过了**
//    （实测 type=15 的 341 门 100% 含 id=9；反例：一门 min_catelogname=工学 但
//     professional_field_id=6 的课在接口里根本搜不到）。所以**不要**在客户端按学科门类筛 ——
//    按「工学」筛会误杀 38 门合法的 经济学/理学 课（全是信息化规划解读、数字经济那类）。
//    这里保留的是一道**断言**：选课前查一次详情，方向不对就跳过并告警。
//    它只在"账号申报信息被改"或"平台改了过滤逻辑"时才会响，平时零影响。
const FIELD_ID = process.env.HZ_FIELD_ID ?? '9';

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

// 学时后台首页。两块数据，用途完全不同，别搞混：
//
//  · data.course —— 🔴 **只返回最近 8 条**，limit/page 传了也没用。它是「最近学习」小挂件，
//    不是全量已学课程。拿它当"已完成集合"，学到第 9 门之后最早那几门就会掉出窗口被重新选回来
//    无限重学；拿它加总当学时，数字会永远卡在 8×0.5=4.0（实测空转了一个半小时）。
//    所以它只作为**辅助**去重，真正的去重靠 state.data.done + blacklist。
//
//  · data.study —— ✅ 平台自己算好的权威学时：每个类别的 r=年度要求 / s=已获得 / w=还差。
//    这才是唯一可信的数字。注意它**只在点过「学时重算」之后才更新**（见 recalc.mjs），
//    学习途中是滞后的。
async function finished(ctl) {
  const j = await post(ctl, '/api/index/Study.UserIndex/index', {});
  const list = (j?.data?.course) || [];
  const req = {};
  for (const x of (j?.data?.study || [])) req[x.coursetype] = { s: Number(x.s) || 0, r: Number(x.r) || 0 };
  return { ids: new Set(list.map(x => String(x.courseid))), req };
}

async function chooseCourse(ctl, ids) {
  const r = await post(ctl, '/api/index/Course/chooseCourse', { courseid: ids });
  return r?.status === 200;
}

// 唯一权威的「专业方向」判据。只有课程详情接口才返回，列表接口里没有。
// 返回 true=方向对得上 / false=对不上（该跳过）/ null=查不到（放行，别因为接口抖动就停摆）
async function fieldOk(ctl, courseid) {
  if (!FIELD_ID) return null;
  const j = await post(ctl, '/api/index/index/getCourseInfo', { courseid }).catch(() => null);
  const v = j?.data?.professional_field_id;
  if (v == null || v === '') return null;
  return String(v).split(',').map(s => s.trim()).includes(FIELD_ID);
}

// 跨平台缺口：问面板要三个平台汇总后的「专业/公需 还差多少」。
// 拿不到就返回 null（调用方退回本站自己的年度要求），绝不因为面板没起来就停摆。
async function crossGap() {
  try {
    const r = await fetch(`http://127.0.0.1:${process.env.PORT || 8848}/json`,
      { signal: AbortSignal.timeout(8000) });
    const j = await r.json();
    const q = t => j.hz?.v?.req?.find(x => x.t === t)?.done || 0;
    const spec = q('专业课程') + (j.nc?.v?.hours || 0);
    const gx = (j.zj?.v?.gen || 0) + (j.zj?.v?.ind || 0) + q('行业公需') + q('一般公需');
    if (j.zj?.err || j.nc?.err) return null;          // 有平台取不到数，汇总就是错的，别据此调度
    return {
      specLeft: Math.max(0, Number(process.env.GOAL_SPEC || 180) - spec),
      gxLeft: Math.max(0, Number(process.env.GOAL_GX || 90) - gx),
    };
  } catch { return null; }
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
    const done = state.data.done ||= {};   // 本进程亲自确认学完的课：{id: {h, type}}
    const doneSet = new Set([...mine.map(x => x.id), ...fin.ids, ...black, ...Object.keys(done)]);
    let pick = null, already = 0;

    // 🔑 学什么，由平台后台的权威要求决定，别硬编码。这个账号（2026）是：
    //      专业课程 要求 60 · 行业公需 要求 0 · 一般公需 要求 0 · 总学时 要求 90
    //    也就是说 60 学时**必须**是专业课程，剩下 30 学时任何类别都行（公需不设下限但计入总数）。
    //    → 专业课程还没补满就先刷专业课程；补满了再拿公需去填总学时的余量。
    //    （历史教训：曾按"公需≥18"的传闻先刷公需，而这个账号公需要求其实是 0。）
    const spec = fin.req['专业课程'] || { s: 0, r: 60 };
    const gxSettled = (fin.req['行业公需']?.s || 0) + (fin.req['一般公需']?.s || 0);
    // data.study 只在「学时重算」后才更新（每天 2~3 次），中间最多滞后半天 →
    // 加上本进程确认完成、但还没结算的那部分（state.data.pend）。
    // ⚠️ 这个增量必须在官方数字变化时清零，否则重算之后就变成"官方 + 已被官方吸收的增量"双计。
    const pend = state.data.pend ||= {};
    const snap = state.data.snap ||= {};
    if (snap.spec !== spec.s || snap.gx !== gxSettled) {
      snap.spec = spec.s; snap.gx = gxSettled;
      for (const k of Object.keys(pend)) pend[k] = 0;   // 刚重算过，增量已被吸收
      state.save();
    }
    const specDone = spec.s + (pend['专业课程'] || 0);
    const gxDone = gxSettled + (pend['行业公需'] || 0) + (pend['一般公需'] || 0);

    // 真正的目标是**三个平台加起来**达标，所以"先学哪一类"要看**跨平台缺口**，
    // 而不是本站自己的年度要求。面板（dashboard.mjs）已经把三个平台的数汇总好了，
    // 直接问它，保持单一事实源；问不到就退回本站自己的要求。
    //
    // 为什么公需优先：本站**一般公需便宜得离谱**（最省的 ~10 分钟就给 1 学时，
    // 而专业课要 ~35 分钟），是所有平台里最划算的学时来源。公需缺口先在这儿填掉，
    // 剩下的产能全给专业课 —— 专业课那 157 学时的缺口主要靠网易云 3 路并行去啃。
    const cross = await crossGap();
    let gxFirst, why;
    if (cross) {
      gxFirst = cross.gxLeft > 0;
      why = gxFirst
        ? `跨平台公需还差 ${cross.gxLeft.toFixed(1)}（本站一般公需最便宜），先补公需`
        : `跨平台公需已达标，专业还差 ${cross.specLeft.toFixed(1)}，刷专业课`;
    } else {
      gxFirst = specDone >= spec.r;
      why = `（拿不到跨平台数，按本站要求）专业 ${specDone.toFixed(1)}/${spec.r}`;
    }
    const order = gxFirst ? [17, 16, 15] : [15, 17, 16];
    log(`${why}｜本站：专业 ${specDone.toFixed(1)} 公需 ${gxDone.toFixed(1)}（官方计入 ${spec.s}/${gxSettled}）`);

    for (const type of order) {
      const inProgress = pending.filter(x => x.type === TYPE_NAME[type])
        .sort((a, b) => (b.vst / b.secs) - (a.vst / a.secs));   // 快学完的先收尾
      if (inProgress.length) { pick = inProgress[0]; already = pick.vst; break; }

      const list = (await catalog(ctl, type)).filter(x => !doneSet.has(x.id) && x.secs > 0 && x.h > 0);
      if (!list.length) continue;
      // 唯一的排序目标：**每学时花的墙钟时间最短**。
      // 别再按学科门类（工学/经济学/理学）排 —— 那个维度和专业方向无关，
      // 服务端已经按账号申报的方向过滤过了，按门类排只会把同样合格的课排到后面。
      list.sort((a, b) => a.secs / a.h - b.secs / b.h);
      let cand = null;
      for (const c of list.slice(0, 20)) {           // 方向不对的极少，最多往下试 20 门
        const ok = type === 15 ? await fieldOk(ctl, c.id) : null;
        if (ok === false) {
          log(`  ⚠ 《${c.name}》 专业领域对不上（要 ${FIELD_ID}），跳过并拉黑`);
          (state.data.blacklist ||= []).push(c.id); state.save();
          continue;
        }
        cand = c; break;
      }
      if (!cand) { log('  连着 20 门方向都对不上，2 分钟后重试'); await sleep(120_000); break; }
      if (!await chooseCourse(ctl, [cand.id])) { log('选课失败', cand.id); await sleep(60_000); break; }
      log(`＋ 选课《${cand.name}》 ${cand.h}学时 ${(cand.secs / cand.h / 60).toFixed(0)}分钟/学时 [${cand.sys}/${cand.cat}]（${TYPE_NAME[type]}还剩 ${list.length} 门）`);
      pick = { id: cand.id, name: cand.name, secs: cand.secs, h: cand.h, type: TYPE_NAME[type] };
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
      // 🔴 顺序不能反！「用时远小于应需时长」必须先判。
      //    平台对"早就拿过学分又被重新选课"的课会秒判 finish=1，**并且同样把它移出我的网络课程**，
      //    所以 `!after` 根本不能证明这轮真学到了东西。先看 !after 的话，空转会被记成成功：
      //    实测这样每轮 ~90s 空转了一个半小时，学时一点没涨，日志里全是 ✅（2026-08-03）。
      //    判据只能用时间：validstudytime 不是实时的（学习途中查到的常常还是 0），指望不上。
      if (spent < (pick.secs - already) * 0.5) {
        log(`  ⛔ 只用了 ${Math.round(spent)}s 平台就判完成（该课需 ${pick.secs}s），说明早已拿过学分，拉黑不再选`);
        (state.data.blacklist ||= []).push(pick.id);
      } else if (!after) {
        log(`  ✅ 《${pick.name}》 完成（已移出我的网络课程）`);
        state.data.doneCount = (state.data.doneCount || 0) + 1;
        // 自己记两笔：done 用来去重（平台的「已学课程」接口只回最近 8 条，指望它必然重学）；
        // pend 是"已学完但还没重算结算"的学时，用来在两次重算之间也能正确判断该学哪一类。
        done[pick.id] = { h: pick.h, type: pick.type || '' };
        if (pick.type) pend[pick.type] = (pend[pick.type] || 0) + pick.h;
      } else {
        log(`  → 本轮学满 ${Math.round(spent)}s，validstudytime=${after.vst}/${after.secs}，下轮继续`);
      }
    }
    state.data.lastId = pick.id; state.save();
    await sleep(8000);
  }
}

main().catch(e => { log('💥', e.stack); process.exit(1); });
