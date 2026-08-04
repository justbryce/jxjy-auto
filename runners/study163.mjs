#!/usr/bin/env node
// 站点 3：网易云课堂（study.163.com）—— 把「我的学习」里所有课程逐课时看完
//
// 机制（已实测）：
//  - 我的课程：GET /j/my/courseListV2.json?pageSize=20&pageIndex=N&keyword=&filterType=0&t=<ts>
//    必须带请求头 edu-script-token = cookie `NTESSTUDYSI`，否则 403（空 body）。
//    返回 result.list[]：courseId / name / units(总课时) / finishedUnits(已完成课时)。
//  - 播放器走 HLS/MSE（video.src 是 blob:），进度每 60s 由 DWR LessonLearnBean.updateVideoTime 上报
//    真实 currentTime → 必须 1x 实播。
//  - 目录 DOM：.m-chapterList .section[data-id=<lessonId>]，.ksicon 的 title 是状态
//    （已完成/进行中/未开始），.ksinfo 是 mm:ss 时长。
//  - ✅ **支持多门课同时播**（实测两个 tab 并发推进互不影响）→ 开 CONCURRENCY 个 worker。
//  - ⚠️ 新建的 tab 必须 /front 一次才会开始加载媒体（Chrome 对从未可见过的 tab 不加载媒体）；
//    同一个 tab 之后再切课时就不用了。
//  - ⚠️ 163 会断点续播，从断点播到尾服务端不判完成 → 每次都从 currentTime=0 播。
//  - 直播/非视频课时起播会失败（DWR 报 learnableInfo null），自动跳过。

import * as cdp from '../lib/cdp.mjs';
import { displayAsleep } from '../lib/display.mjs';
import { sleep, evalJs, evalJson } from '../lib/cdp.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONCURRENCY = Number(process.env.NC_CONCURRENCY || 3);
const POLL = 20_000;
// 静音播放。⚠️ 只能用 volume=0，**绝不能** muted=true —— 那样 Chrome 会在 play 后约 6ms 直接暂停。
// （试过用 volume>0 让 Chrome 认为"页面在发声"从而豁免隐藏页节流 —— 行不通，见文件底部 ensureVisible 的注释。）
const VOLUME = Number(process.env.NC_VOLUME || 0);
const log = cdp.makeLogger('163');
const state = cdp.makeState(path.join(HERE, '../state/study163.json'));
state.data.skipped = state.data.skipped || {};   // courseId -> [lessonId]（永久跳过）
state.data.fails = state.data.fails || {};       // lessonId -> 连续失败次数（成功即清零）
// 连续失败多少次才认定"这个课时真的学不了"。别设成 1 —— 环境临时坏掉会成批误杀。
const SKIP_AFTER = Number(process.env.NC_SKIP_AFTER || 3);
state.data.tries = state.data.tries || {};       // lessonId -> n

const learnUrl = (cid, lid) => `https://study.163.com/course/courseLearn.htm?courseId=${cid}` + (lid ? `#/learn/video?lessonId=${lid}&courseId=${cid}` : '');

const LESSONS = `(()=>JSON.stringify([...document.querySelectorAll(".m-chapterList .section")].map(s=>({
  id:s.dataset.id, idx:+s.dataset.lesson,
  name:(s.querySelector(".ksname")||{}).innerText||"",
  st:(s.querySelector(".ksicon")||{}).title||"",
  info:((s.querySelector(".ksinfo")||{}).innerText||"").trim()}))))()`;

const VSTAT = `(()=>{const v=document.querySelector("video");
  if(!v) return JSON.stringify({none:true,url:location.href});
  return JSON.stringify({cur:v.currentTime,dur:v.duration,paused:v.paused,ready:v.readyState,url:location.href})})()`;

// ⚠️ 不要 await v.play()：加载不动时 Promise 永不 settle，CDP eval 会挂到超时把进程带崩
const KICK = `(()=>{const v=document.querySelector("video");
  if(!v) return 0;
  v.muted=false;v.volume=${VOLUME};v.playbackRate=1;
  try{const p=v.play();if(p&&p.catch)p.catch(e=>{window.__playErr=e.name})}catch(e){window.__playErr=e.name}
  return 1})()`;

// ---------- 课程清单 ----------
async function myCourses(t) {
  return evalJson(t, `(async()=>{const tk=(document.cookie.match(/(?:^|;\\s*)NTESSTUDYSI=([^;]+)/)||[])[1]||"";
    const out=[];
    for(let p=1;p<=10;p++){
      const r=await fetch("/j/my/courseListV2.json?pageSize=20&pageIndex="+p+"&keyword=&filterType=0&t="+Date.now(),
        {headers:{"edu-script-token":tk,"Accept":"application/json"}});
      if(!r.ok) return JSON.stringify({err:r.status});
      const j=await r.json();
      // ⚠️ 会话失效时 163 返回的是 HTTP 200 + {code:-2,message:"not_auth"}，不是 401/403。
      //    不检这个的话会拿到空列表，脚本以为"没课可学"，而视频照播（CDN 不校验登录）——
      //    结果是进程忙得飞起、一秒学习记录都没有。2026-08-03 就这么空转了十几分钟。
      if (j && (j.code === -2 || j.message === 'not_auth')) return JSON.stringify({ notAuth: true });
      const L=(j.result&&j.result.list)||[];
      out.push(...L.map(x=>({id:String(x.courseId),name:x.name,units:x.units,fin:x.finishedUnits})));
      if(p>=((j.result&&j.result.query&&j.result.query.totlePageCount)||1))break;}
    return JSON.stringify({list:out})})()`);
}

// 把本项目所有 163 tab 里的视频停掉。会话失效时必须调 ——
// 否则 runner 已经停了，视频还在各自的 tab 里自顾自播，纯烧带宽且一秒都不计数。
async function pauseAll() {
  for (const k of Object.keys(state.data)) {
    if (!/^tab\d+$/.test(k)) continue;
    await evalJs(state.data[k], `(()=>{const v=document.querySelector("video");if(v)v.pause();return 1})()`)
      .catch(() => { });
  }
  log('  已暂停所有 tab 的视频');
}

// ---------- worker ----------
// 回收上一代进程留下的 tab。
// runner 被 pkill / 看门狗重启时，它自己建的 tab 全都留在 Chrome 里没人收 ——
// 重启十几次就能攒出几十个 tab，既占内存，又把 CDP 代理的 session 拖爆
// （实测 11 个活着的 tab 对应 184 个 session，代理慢到光列 tab 就要 13 秒，
//  连带把汇总面板卡成"服务挂了"）。
// 只关**我们自己建过**的（记在 state.owned 里），绝不按 URL 乱扫 ——
// 这是用户日常的 Chrome，他自己开的 163 页面不能碰。
async function reapOrphanTabs() {
  const owned = state.data.owned || [];
  const inUse = new Set(Object.entries(state.data)
    .filter(([k]) => /^tab\d+$/.test(k)).map(([, v]) => v));
  let n = 0;
  for (const id of owned) {
    if (inUse.has(id)) continue;
    if (await cdp.tabAlive(id)) { await cdp.closeTab(id).catch(() => { }); n++; }
  }
  state.data.owned = [...inUse];
  state.save();
  if (n) log(`回收上一代残留的 ${n} 个 tab`);
}

async function ensureTab(w) {
  const key = `tab${w}`;
  if (state.data[key] && await cdp.tabAlive(state.data[key])) return state.data[key];
  const r = await cdp.newTab('https://study.163.com/my#/courses');
  state.data[key] = r.targetId;
  (state.data.owned ||= []).push(r.targetId);
  state.save();
  // 等页面真的落到 study.163.com 再用它打接口 —— 页面还停在 about:blank 时，
  // 相对路径的 fetch 会解析到错误的 origin，接口直接 404，很有迷惑性。
  for (let i = 0; i < 12; i++) {
    await sleep(2000);
    const u = await cdp.info(r.targetId).then(x => x?.url || '').catch(() => '');
    if (u.includes('study.163.com')) break;
  }
  await sleep(3000);
  // 新 tab 必须可见一次，之后才肯加载媒体
  await cdp.kickVisible(r.targetId, { waitMs: 3000, tag: '163' });
  log(`w${w} 新建 tab ${r.targetId}`);
  return r.targetId;
}

// 只认真正的浮层：fixed/absolute + z-index 高 + 不包含播放器本身
// （播放器的控制条 class 里也带 layer，早期版本会把 "10:09 / 14:35 1x 标清" 误报成弹窗）
async function popupText(t) {
  return evalJs(t, `(()=>{const out=[];
    for(const e of document.querySelectorAll("[class*=dialog],[class*=modal],[class*=popup],[class*=u-mask],[class*=confirm]")){
      if(!e.offsetParent) continue;
      if(e.querySelector("video")) continue;
      const cs=getComputedStyle(e);
      if(!/fixed|absolute/.test(cs.position)) continue;
      if((Number(cs.zIndex)||0)<10) continue;
      const tx=(e.innerText||"").trim();
      if(tx.length>2&&tx.length<300) out.push(tx.slice(0,150));
    }
    return [...new Set(out)].join(" | ").slice(0,300)})()`).catch(() => '');
}

// 播放途中会话也可能失效（同一账号在别处登录、并发流太多被判异常……）。
// ⚠️ 别用手工构造的 DWR 请求来探活：`httpSessionId` 我们拿不到，服务端**无论登没登录**
//    都会回 SecurityException，是个 100% 的假阳性（踩过）。
//    用课程列表接口最准：会话正常 code:0，失效时 HTTP 200 + code:-2 not_auth。
async function sessionAlive(t) {
  const r = await evalJs(t, `(async()=>{try{
    const tk=(document.cookie.match(/(?:^|;\\s*)NTESSTUDYSI=([^;]+)/)||[])[1]||"";
    const q=await fetch("/j/my/courseListV2.json?pageSize=1&pageIndex=1&keyword=&filterType=0&t="+Date.now(),
      {headers:{"edu-script-token":tk,"Accept":"application/json"}});
    if(!q.ok) return "unknown";
    const j=await q.json();
    return (j&&(j.code===-2||j.message==="not_auth")) ? "dead" : "ok";
  }catch(e){return "unknown"}})()`).catch(() => 'unknown');
  return r !== 'dead';
}

// 🔴 163 的播放页是 SPA：**换课时不重新加载页面，JS 堆只涨不落**。
// 2026-08-04 实测跑了 40 分钟之后，4 个 worker 的堆分别是 1185 / 3765 / 1006 / 1335 MB，
// 而 Chrome 的堆上限是 4192 MB —— 那个 3765 的马上就要把渲染进程撑爆。
// 这也是整台 16G 机器反复被顶到"内存压力等级 2"的真正原因（Chrome 单进程能吃到 1.7G）。
//
// 解法：换课时之前先看堆，超过阈值就**整页重载**（SPA 内部跳转不释放，必须真 reload）。
// 代价几乎为零：163 本来就不认断点续播，每个课时都是从 currentTime=0 重新播的。
const HEAP_MAX_MB = Number(process.env.NC_HEAP_MAX_MB || 900);
async function recycleIfBloated(t, w) {
  const mb = Number(await evalJs(t, `(()=>Math.round((performance.memory?performance.memory.usedJSHeapSize:0)/1048576))()`).catch(() => 0));
  if (!mb || mb < HEAP_MAX_MB) return mb;
  log(`w${w}   ♻️ JS 堆 ${mb}MB 超过 ${HEAP_MAX_MB}MB，整页重载释放（SPA 换课时不会释放）`);
  await cdp.navigate(t, 'about:blank').catch(() => { });
  await sleep(1500);
  return mb;
}

async function watch(t, w, cid, ls) {
  log(`w${w} ▶ ${ls.cname ? '《' + ls.cname + '》 ' : ''}课时${ls.idx + 1} ${ls.name} ${ls.info || '(无时长)'}`);
  await recycleIfBloated(t, w).catch(() => { });
  await cdp.navigate(t, learnUrl(cid, ls.id));
  await sleep(9000);

  // 等 <video> 的 duration 和目录里的 mm:ss 对上，避免读到上一课时的残留播放器
  const want = /^(\d+):(\d+)$/.test(ls.info) ? (+RegExp.$1 * 60 + +RegExp.$2) : 0;
  for (let i = 0; i < 12 && want; i++) {
    const s = await evalJson(t, VSTAT).catch(() => null);
    if (s && !s.none && s.dur > 0 && Math.abs(s.dur - want) <= 5) break;
    await sleep(3000);
  }

  // 163 断点续播 → 从头播，否则服务端不判完成
  await evalJs(t, `(()=>{const v=document.querySelector("video");if(v&&v.currentTime>5)v.currentTime=0;return 1})()`).catch(() => { });

  // 🔑 保持这个 tab 可见 —— 这是 163 能不能跑满 1x 的关键。
  //    Chrome 对 hidden 页面做密集节流（定时器降到 ~1 次/分钟），hls.js 的分片加载循环被掐住，
  //    缓冲喂不上 → 速率掉到 30~60%（缓冲区会出现断层，但网络其实几毫秒就返回，很有迷惑性）。
  //    这台机器平时没人用的话，可以把 Chrome 提到前台 + 把本 tab 设为当前 tab，visibilityState 就是 visible。
  //    （试过用 volume>0 让 Chrome 认为"在发声"从而豁免节流 —— 行不通：有声播放需要 user activation，
  //      而 CDP 的合成点击在这个页面上拿不到 activation，play() 一直抛 NotAllowedError。）
  await cdp.clickAt(t, 'video').catch(() => { });
  await sleep(1200);

  let s = null;
  for (let i = 0; i < 5; i++) {
    await evalJs(t, KICK).catch(() => { });
    await sleep(3000);
    s = await evalJson(t, VSTAT).catch(() => null);
    if (s && !s.none && !s.paused && s.dur > 0) break;
    if (i === 1) await cdp.kickVisible(t, { waitMs: 3500, tag: '163' });   // 媒体没起来，踢一下可见性
    await cdp.clickAt(t, 'video').catch(() => { });
  }
  if (!s || s.none || !(s.dur > 0)) {
    // 🔴 起播失败之前，先排除"整个环境根本不具备播放条件"。
    // 显示器休眠时，hidden 页面被节流到定时器 ~1 次/分钟，163 的 SPA **连 <video> 都挂载不出来**，
    // 于是**每一个**课时都会"起播失败"。这时候如果照常记失败计数，
    // 三轮下来就会把整个队列永久跳过 —— 又一次"拿环境故障给课程判死刑"。
    if (s?.none && displayAsleep()) {
      log(`w${w}   ⏸ 显示器休眠，页面被节流到播放器都挂载不出来 —— 这不是课时的问题，等 5 分钟再说`);
      await sleep(300_000);
      return 'env';        // 上层不会把 'env' 计入失败次数
    }
    const pu = await popupText(t);
    log(`w${w}   起播失败${pu ? ' 弹窗:' + pu.slice(0, 100) : ''}（多半是直播/非视频课时）`);
    return 'skip';
  }

  await ensureVisible(t, w);

  let last = -1, stall = 0, lastPct = -1;
  const t0 = Date.now(), startCur = s.cur || 0;
  while (Date.now() - t0 < 4 * 3600_000) {
    await sleep(POLL);
    const v = await evalJson(t, VSTAT).catch(() => null);
    if (!v || v.none) { log(`w${w}   播放器丢了`); return 'retry'; }
    // ⚠️ URL 变了**不一定是出错** —— 视频播到头时 163 的 SPA 会**自己跳到下一课时**，
    //    URL 里的 lessonId 跟着变。这时候上一课时其实是**学完了**。
    //    以前一律记成「页面跳走了」+ retry：行为上无害（retry 不烧跳过计数，队列每轮从平台重建，
    //    平台已判完成的课时下轮自然被过滤掉），但**日志把成功写成了失败的样子**，
    //    对账时极容易误判成空转 —— 实测「✓ 播完」只占真实完成量的 1/4，剩下 3/4 全躲在这条里。
    //    现在按最后一次已知进度区分：≥90% 就是播完了，别再冤枉它。
    if (!String(v.url).includes(`lessonId=${ls.id}`)) {
      if (lastPct >= 90) {
        log(`w${w}   ✓ 播完（平台自动跳到了下一课时）`);
        (state.data.watched ||= {})[ls.id] = { c: cid, s: Math.round(last > 0 ? last : 0), name: ls.name, at: Date.now() };
        state.save();
        return 'done';
      }
      log(`w${w}   页面跳走了（当时才 ${lastPct < 0 ? '?' : lastPct}%，不是正常播完）`);
      return 'retry';
    }
    if (v.dur && v.cur >= v.dur - 2) {
      log(`w${w}   ✓ 播完`);
      // 163 平台不统计学时，自己记账：课时 -> 秒数（去重，重播不重复计）
      (state.data.watched ||= {})[ls.id] = { c: cid, s: Math.round(v.dur), name: ls.name, at: Date.now() };
      state.save();
      await sleep(10000);
      return 'done';
    }

    if (v.paused || Math.abs(v.cur - last) < 1) {
      if (++stall >= 3) {
        const pu = await popupText(t);
        if (pu) {
          log(`w${w}   ⚠ 疑似弹窗:`, pu.slice(0, 120));
          await cdp.screenshot(t, path.join(HERE, `../logs/163-popup-${Date.now()}.png`)).catch(() => { });
          await evalJs(t, `(()=>{const b=[...document.querySelectorAll("a,button,span,div")]
            .find(e=>e.offsetParent&&/^(继续学习|我知道了|确定|好的|继续观看|知道了)$/.test((e.innerText||"").trim()));
            if(b){b.click();return 1}return 0})()`).catch(() => { });
        }
        log(`w${w}   卡在 ${Math.round(v.cur)}s，重新唤起`);
        await evalJs(t, KICK).catch(() => { });
        stall = 0;
      }
    } else stall = 0;
    last = v.cur;

    // 速率明显掉下来通常就是丢了可见性（别的 runner 抢走 /front，或者 Chrome 被别的窗口盖住）
    if (v.cur > startCur + 30) {
      const rate = (v.cur - startCur) / ((Date.now() - t0) / 1000);
      if (rate < 0.8) await ensureVisible(t, w);
    }

    const pct = v.dur ? Math.floor(v.cur / v.dur * 10) * 10 : 0;
    if (pct !== lastPct) {
      lastPct = pct;
      // 播放速率：Chrome 对多个隐藏 tab 里同时播的视频会限速，低于 100% 说明被throttle了
      const rate = Math.round((v.cur - startCur) / ((Date.now() - t0) / 1000) * 100);
      log(`w${w}   ${pct}%  ${Math.round(v.cur)}/${Math.round(v.dur)}s  速率${rate}%`);
    }
  }
  return 'timeout';
}

// 让本 tab 真正 visible：先把 Chrome 窗口提到前台（不然被遮挡时当前 tab 也是 hidden），
// 再把本 tab 设为当前 tab。restore:false —— 我们要占住这个槽位不还。
let lastEnsure = 0, yieldLogged = 0;
async function ensureVisible(t, w) {
  try {
    const vis = await evalJs(t, 'document.visibilityState').catch(() => null);
    if (vis === 'visible') return;
    if (Date.now() - lastEnsure < 30_000) return;      // 别太频繁地抢
    lastEnsure = Date.now();

    // 🚦 礼让：可见槽位只有一个。如果占着它的是别人的 tab（比如别的高优先级自动化任务，
    //    那个靠真实点击工作、优先级远高于刷课），就不抢 —— 宁可慢一半也不能干扰它。
    const cur = await cdp.visibleTab().catch(() => null);
    if (cur && !isOurTab(cur)) {
      if (Date.now() - yieldLogged > 600_000) {
        yieldLogged = Date.now();
        const info = await cdp.info(cur).catch(() => null);
        log(`w${w}   可见槽位被别的任务占着（${(info?.url || '?').slice(0, 50)}），让路，本站会慢一些`);
      }
      return;
    }

    // 实测：即便把本 tab 设为当前 tab，只要它所在的 Chrome 窗口被别的窗口盖住（前台常被别的 App 占着），
    // visibilityState 依然是 hidden，抢也没用。而抢的代价是可能把可见槽位从别的任务手里拿走。
    // 收益不确定 + 有风险 → 不抢，只记录。163 慢一半可以接受（它不产生学时）。
    if (Date.now() - yieldLogged > 1800_000) {
      yieldLogged = Date.now();
      log(`w${w}   tab 处于后台，Chrome 会限速 hls.js 的分片加载（约 30~60% 速率），属已知现象`);
    }
  } catch { }
}

// 本项目自己开的 tab（三个站的 runner 都把 tab id 存在 state/ 里）
function isOurTab(id) {
  try {
    for (const f of ['study163.json', 'zjsjczx.json', 'hzrs.json']) {
      const d = JSON.parse(fs.readFileSync(path.join(HERE, '../state/' + f), 'utf8'));
      if (Object.values(d).includes(id)) return true;
    }
  } catch { }
  return false;
}

// 读某门课的课时目录。必须整页加载课程页 —— watch() 用过的页面上，课时状态是"开播之前"的旧快照。
async function lessonsOf(t, cid) {
  await cdp.navigate(t, learnUrl(cid));
  await sleep(9000);
  for (let i = 0; i < 8; i++) {
    const all = (await evalJson(t, LESSONS).catch(() => [])) || [];
    if (all.length) return all;
    await sleep(3000);
  }
  return [];
}

// 把所有未学完课程的待学课时拉平成一个队列。
// 为什么按"课时"而不是按"课程"分派：163 只剩两门大课时，按课程分派最多只能开 2 个 worker；
// 实测同一门课的不同课时可以在不同 tab 里同时播，按课时分派就不受课程数限制了。
async function buildQueue(t, courses) {
  const q = [];
  for (const c of courses) {
    const all = await lessonsOf(t, c.id);
    // 读不到课时列表**几乎不可能是"这门课真的没有课时"**，而是页面没渲染出来或登录态出问题
    // （实测：Chrome 的 Google 账号掉线那会儿，十几门课连着读不到）。
    // 所以只是本轮跳过、下一轮还会重试，不要落盘成永久跳过。
    if (!all.length) { log(`  读不到《${c.name}》的课时列表（页面没渲染出来？登录态？），本轮跳过，下轮重试`); continue; }
    const skipped = state.data.skipped[c.id] || [];
    const todo = all.filter(x => x.st !== '已完成' && !skipped.includes(x.id));
    log(`  《${c.name}》 ${all.length} 课时，已完成 ${all.filter(x => x.st === '已完成').length}，跳过 ${skipped.length}，待学 ${todo.length}`);
    for (const ls of todo) q.push({ cid: c.id, cname: c.name, ...ls });
  }
  // 短课时优先。163 **不认断点续播**（从断点播到尾服务端不判完成），所以一个课时必须
  // 一口气播完才算数 —— 中途任何一次重启（自愈 / 看门狗 / 崩溃）都让这一整段白播。
  // 于是「课时时长」直接等于「暴露在中断风险下的时间」：
  // 2026-08-04 实测，87 分钟的《比特币：共识协议》在 11 分钟一次的重启节奏下被重开 36 次，
  // 累计播了约 6 小时，得到 0 学时。同样这 6 小时如果都用来播 10 分钟的课时，能完成 30 多个。
  // 排序只影响先学哪个，不跳过任何课时，长课时照样会轮到 —— 但要等系统证明自己能连续跑那么久。
  q.sort((a, b) => secsOf(a.info) - secsOf(b.info));
  return q;
}

// "87:33" / "1:12:05" → 秒。
// ⚠️ 解析不出时长的要排**最后**不是最前：163 里没有时长的课时几乎全是作业/考试/资料链接，
// 根本没有 <video>，起播必然失败。排最前会让 10 个 worker 一开局全去啃这些空课时，
// 白白把连续失败计数烧掉（2026-08-04 第一版排序就是这么翻车的）。
const NO_DUR = 1e9;
function secsOf(info) {
  const m = String(info || '').match(/(\d+):(\d+)(?::(\d+))?/);
  if (!m) return NO_DUR;
  return m[3] ? +m[1] * 3600 + +m[2] * 60 + +m[3] : +m[1] * 60 + +m[2];
}

let reaped = false;
async function loop() {
  // 进程刚起来时收一次上一代的残留 tab（只做一次，之后不用重复扫）
  if (!reaped) { reaped = true; await reapOrphanTabs().catch(e => log('回收残留 tab 失败:', e.message)); }
  const t0 = await ensureTab(0);
  const res = await myCourses(t0);
  if (res?.notAuth) {
    await pauseAll();          // 别让视频继续空转烧带宽 —— 这时候播多少都不算数

    log('❌ 登录态失效（接口返回 not_auth）—— 视频还能播但一秒都不会被记录，先停下来。请在 Chrome 里重新登录 study.163.com，10 分钟后自动重试');
    await sleep(600_000);
    return;
  }
  if (!res || res.err) { log(`❌ 取课程列表失败(${res?.err})，10 分钟后重试`); await sleep(600_000); return; }

  const courses = res.list.filter(c => c.fin < c.units);
  log(`我的学习：${res.list.length} 门课，未学完 ${courses.length} 门，共 ${res.list.reduce((a, b) => a + b.units, 0)} 课时（已完成 ${res.list.reduce((a, b) => a + b.fin, 0)}）`);
  if (!courses.length) return 'finished';

  courses.sort((a, b) => (a.units - a.fin) - (b.units - b.fin));   // 小课先清掉
  const queue = await buildQueue(t0, courses);
  if (!queue.length) { log('没有待学课时了，10 分钟后重查'); await sleep(600_000); return; }
  log(`本轮队列共 ${queue.length} 个课时，${Math.min(CONCURRENCY, queue.length)} 个 worker 并行`);

  let next = 0;
  const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, (_, w) => (async () => {
    const t = w === 0 ? t0 : await ensureTab(w);
    while (true) {
      const task = queue[next++];
      if (!task) return;
      if (!await sessionAlive(t)) {
        log(`w${w} ❌ 登录态失效，停止本轮（请重新登录 study.163.com）`);
        await pauseAll();
        return;
      }
      try {
        const r = await watch(t, w, task.cid, task);
        if (r === 'env') { next--; continue; }   // 环境问题，这个课时原样放回去重试，不计失败
        if (r === 'skip' || r === 'timeout') {
          // 🔴 **不要凭一次失败就永久跳过。**
          // skip/timeout 里混着两种完全不同的事：
          //   ① 这个课时真的不是视频（直播预告、"务必添加班主任微信"那种）—— 该永久跳过
          //   ② 环境临时坏了（登录态掉线、Chrome 抽风、页面没渲染出来）—— 一会儿就好了
          // 两者返回值一模一样，凭一次就落盘的话，环境一坏就会成批判死 ——
          // 实测 Chrome 的 Google 账号掉线那阵子，一口气废掉了 86 个课时
          // （整门《Rust编程语言基础教程》26 个课时全军覆没）。
          // 所以要连着失败 SKIP_AFTER 次才永久跳过；失败计数在成功时清零。
          const f = (state.data.fails[task.id] = (state.data.fails[task.id] || 0) + 1);
          if (f >= SKIP_AFTER) {
            (state.data.skipped[task.cid] ||= []).push(task.id);
            log(`w${w}   → 连续 ${f} 次${r}，永久跳过`);
          } else {
            log(`w${w}   → 本次${r}（第 ${f}/${SKIP_AFTER} 次），下轮还会再试`);
          }
        } else if (r === 'done') {
          delete state.data.fails[task.id];
          const n = (state.data.tries[task.id] = (state.data.tries[task.id] || 0) + 1);
          if (n >= 3) { (state.data.skipped[task.cid] ||= []).push(task.id); log(`w${w}   → 播了 ${n} 遍仍未标完成，跳过`); }
        }
        state.save();
      } catch (e) { log(`w${w} ⚠ 课时出错:`, e.message); await sleep(20_000); }
      await sleep(4000);
    }
  })());
  await Promise.all(workers);
}

async function main() {
  while (true) {
    try {
      if (await loop() === 'finished') { log('🎉 所有课程都学完了，退出'); return; }
    } catch (e) { log('⚠ 本轮异常，30 秒后继续:', e.message); await sleep(30_000); }
    await sleep(10_000);
  }
}

main().catch(e => { log('💥', e.stack); process.exit(1); });
