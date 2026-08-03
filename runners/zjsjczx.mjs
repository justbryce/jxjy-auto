#!/usr/bin/env node
// 站点 1：浙江省工信领域专业技术人员继续教育（engineer.zjsjczx.org.cn）
//
// 机制（已实测）：服务端只认真实播放 —— 播放页每 30s POST /jeecg-boot/zg/student/sync/progress
// {coursewareId,currentTime,duration}，服务端存 longesttime 取最大值。所以必须 1x 实播。
// 目标：把站内所有未完成课件播完，按 行业公需 → 专业科目 → 一般公需 的顺序。

import * as cdp from '../lib/cdp.mjs';
import { sleep, evalJs, evalJson } from '../lib/cdp.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ORIGIN = 'https://engineer.zjsjczx.org.cn';
const HOME = ORIGIN + '/zg/student/learning-center';
const POLL = 20_000;
const log = cdp.makeLogger('zj');
const state = cdp.makeState(path.join(HERE, '../state/zjsjczx.json'));

const TOKEN = `JSON.parse(localStorage.getItem("JEECGBOOT_PRO__PRODUCTION__3.8.3__COMMON__LOCAL__KEY__")).value.TOKEN__.value`;

async function api(target, url) {
  return evalJson(target, `(async()=>{const t=${TOKEN};
    const r=await fetch(${JSON.stringify(url)},{headers:{"X-Access-Token":t}});
    return JSON.stringify(await r.json())})()`);
}

async function getHours(target) {
  const j = await api(target, `/jeecg-boot/zg/apply/myHours?year=${new Date().getFullYear()}`);
  return j?.result ? { gen: +j.result.genclasstime || 0, ind: +j.result.indclasstime || 0, sum: +j.result.classtimesum || 0 } : null;
}

async function getCourses(target, type) {
  const j = await api(target, `/jeecg-boot/zg/student/courseware/list?pageNo=1&pageSize=500&zgcZglType=${type}`);
  if (!j?.success) return null;
  return (j.result?.records || []).map(x => ({
    id: x.zgcId, title: x.title, len: +x.length || 0, lt: +x.longesttime || 0,
    p: +x.progress || 0, ct: +x.classtime || 0, type,
  }));
}

// ---- tab ----
async function ensureTab() {
  if (state.data.target && await cdp.tabAlive(state.data.target)) return state.data.target;
  const r = await cdp.newTab(HOME);
  state.data.target = r.targetId;
  state.save();
  log('新建工作 tab', r.targetId);
  await sleep(5000);
  return r.targetId;
}

async function videoState(target) {
  return evalJson(target, `(()=>{const v=document.querySelector("video");
    if(!v) return JSON.stringify({none:true,url:location.href});
    return JSON.stringify({cur:v.currentTime,dur:v.duration,paused:v.paused,ready:v.readyState,net:v.networkState,vis:document.visibilityState,url:location.href})})()`);
}

// 启动播放：先 /front 让 Chrome 真的去加载 mp4（隐藏 tab 里原生 video 一秒都不加载），
// 再用真实鼠标点击拿用户手势，然后 volume=0（绝不能 muted=true）+ 1x 播。
async function startPlayback(target, c, { forceFront = false, allowResume = false } = {}) {
  // 只在真需要时才抢 /front（会把 Chrome 当前活动 tab 抢走，用户可能在用）。
  // 实测：一个 tab 只要「可见过一次」，之后整页跳转也能在后台正常加载媒体。
  const pre = await evalJson(target, `(()=>{const v=document.querySelector("video");
    return JSON.stringify({ready:v?v.readyState:-1})})()`).catch(() => null);
  if (forceFront || !pre || pre.ready < 2) await cdp.kickVisible(target, { waitMs: 4000, tag: 'zj' });

  // 先等视频真的加载出来再 play。有些课件的 src 是后端签发的
  // （/jeecg-boot/zg/courseware/video/play?coursewareId=..&token=..，不是 OSS 直链），
  // 拿到 src 要好几秒；这期间 play() 会抛 NotSupportedError，白白耗掉一轮重试。
  for (let i = 0; i < 12; i++) {
    const st = await evalJson(target, `(()=>{const v=document.querySelector("video");
      window.__playErr=null;                      // 清掉上一轮的残留错误，否则会一直报同一个
      if(!v) return JSON.stringify({ready:-1});
      return JSON.stringify({ready:v.readyState,src:!!(v.currentSrc||v.src)})})()`).catch(() => null);
    if (st && st.ready >= 2) break;
    await sleep(2500);
  }

  // 真实点击 video 元素本身取得用户手势。注意：点 .video-container 中心有可能落在进度条上导致误 seek，
  // 所以点完立刻把 currentTime 显式写回我们要的位置。
  await evalJs(target, `(()=>{const v=document.querySelector("video");if(v)v.id="__pv";return 1})()`).catch(() => { });
  await cdp.clickAt(target, '#__pv').catch(() => { });

  // ⚠️ 不要 await v.play()：视频加载不动时那个 Promise 永不 settle，会把 CDP eval 挂到超时。
  // allowResume=true 表示页面没有重新加载（同 URL navigate），视频还在原地真实播着，别去动它的位置。
  const seekTo = (c.lt > 30 && c.lt < c.len - 15) ? Math.floor(c.lt) : 0;
  if (allowResume) {
    await evalJs(target, `(()=>{const v=document.querySelector("video");
      if(!v) return 0; v.muted=false; v.volume=0; v.playbackRate=1;
      try{const p=v.play();if(p&&p.catch)p.catch(e=>{window.__playErr=e.name})}catch(e){window.__playErr=e.name}
      return 1})()`).catch(() => { });
    await sleep(2000);
    return evalJson(target, `(()=>{const v=document.querySelector("video");
      if(!v) return JSON.stringify({none:true});
      return JSON.stringify({paused:v.paused,cur:v.currentTime,dur:v.duration,ready:v.readyState,err:window.__playErr||null})})()`);
  }
  await evalJs(target, `(()=>{const v=document.querySelector("video");
    if(!v) return 0;
    v.muted=false; v.volume=0; v.playbackRate=1;
    if(Math.abs(v.currentTime-${seekTo})>3) v.currentTime=${seekTo};
    try{const p=v.play();if(p&&p.catch)p.catch(e=>{window.__playErr=e.name})}catch(e){window.__playErr=e.name}
    return 1})()`).catch(() => { });
  await sleep(3000);

  // 页面是新加载的，视频本该从 0 起。若此刻位置远超我们要的起点，说明真实鼠标点击落在了进度条上把它 seek 走了。
  // 服务端按上报的 currentTime 取最大值记 longesttime —— 那等于白拿没看过的进度，必须纠正回来。
  const fixed = await evalJson(target, `(()=>{const v=document.querySelector("video");
    if(!v) return JSON.stringify({none:true});
    let jumped=false;
    if(v.currentTime > ${seekTo} + 15){ v.currentTime=${seekTo}; jumped=true;
      try{const p=v.play();if(p&&p.catch)p.catch(()=>{})}catch(e){} }
    return JSON.stringify({jumped,paused:v.paused,cur:v.currentTime,dur:v.duration,ready:v.readyState,err:window.__playErr||null})})()`);
  if (fixed?.jumped) log(`  ⚠ 起播位置被误 seek，已拉回 ${seekTo}s`);
  return fixed;
}

async function playCourse(target, c) {
  log(`▶ 《${c.title}》 id=${c.id} ${Math.round(c.len / 60)}分钟 ${c.ct}学时 已看${Math.round(c.p * 100)}%`);
  // 打个标记，用来判断 navigate 之后页面到底有没有真的重新加载
  // （navigate 到当前已经在的同一个 URL 不会 reload，视频还在原地真实播着 —— 那种情况别去改它位置）
  await evalJs(target, `(()=>{window.__navMark=1;return 1})()`).catch(() => { });
  await cdp.navigate(target, `${ORIGIN}/zg/student/video-player?id=${c.id}`);
  await sleep(6000);
  const sameDoc = !!(await evalJs(target, `!!window.__navMark`).catch(() => false));
  if (sameDoc) log('  （页面未重载，接着上次的位置继续播）');

  let started = false;
  for (let i = 0; i < 5 && !started; i++) {
    const k = await startPlayback(target, c, { forceFront: i > 0, allowResume: sameDoc });
    if (k && !k.none && !k.paused && k.ready >= 2) { started = true; break; }
    log('  启动重试', i + 1, JSON.stringify(k));
    await sleep(5000);
  }
  if (!started) { log('  启动失败，跳过'); return 'retry'; }

  let last = -1, stall = 0, lastPct = -1, pollErr = 0;
  const t0 = Date.now(), budget = (c.len + 1200) * 1000;
  while (Date.now() - t0 < budget) {
    await sleep(POLL);
    let s;
    try { s = await videoState(target); pollErr = 0; }
    catch (e) {
      log('  轮询失败', e.message);
      // Chrome 重启过的话 tab id 就没了，这里会一直 "No target with given id found"。
      // 不跳出去的话会在这个循环里空转到 budget 用完（最长 40 分钟）。
      if (++pollErr >= 3) { log('  连续 3 次轮询失败，回上层重建 tab'); state.data.target = null; state.save(); return 'retry'; }
      continue;
    }
    if (!s || s.none || !s.url.includes(`id=${c.id}`)) { log('  页面丢失'); return 'retry'; }
    if (s.dur && s.cur >= s.dur - 2) { log(`  ✓ 播完`); return 'done'; }

    // 向前跳跃 = 误 seek（正常 1x 播每轮只前进 POLL 秒）。拉回来，不白拿没看过的进度。
    if (last >= 0 && s.cur - last > POLL / 1000 + 30) {
      log(`  ⚠ 检测到向前跳跃 ${Math.round(last)}s → ${Math.round(s.cur)}s，拉回`);
      await evalJs(target, `(()=>{const v=document.querySelector("video");v.currentTime=${Math.floor(last)};
        try{const p=v.play();if(p&&p.catch)p.catch(()=>{})}catch(e){} return 1})()`).catch(() => { });
      continue;
    }

    if (s.paused || Math.abs(s.cur - last) < 1) {
      if (++stall >= 3) {
        log(`  卡在 ${Math.round(s.cur)}s (paused=${s.paused} ready=${s.ready} vis=${s.vis})，重新唤起`);
        await startPlayback(target, { ...c, lt: s.cur }, { forceFront: s.ready < 2 });
        stall = 0;
      }
    } else stall = 0;
    last = s.cur;

    const pct = s.dur ? Math.floor(s.cur / s.dur * 10) * 10 : 0;
    if (pct !== lastPct) { lastPct = pct; log(`  ${pct}%  ${Math.round(s.cur)}/${Math.round(s.dur)}s`); }
  }
  log('  超时放弃');
  return 'timeout';
}

// 等网站把进度上报上去（它自己每 30s 报一次）
async function waitCredited(target, c) {
  for (let i = 0; i < 8; i++) {
    await sleep(15000);
    const list = await getCourses(target, c.type);
    const cur = list?.find(x => x.id === c.id);
    if (cur && cur.p >= 1) { log(`  ✓ 已计入 ${c.ct} 学时`); return true; }
    if (i === 3) {
      log('  尚未计入，回退 30s 重播逼它上报');
      await evalJs(target, `(()=>{const v=document.querySelector("video");if(v){v.currentTime=Math.max(0,v.duration-30);v.play()}return 1})()`).catch(() => { });
    }
  }
  log('  ⚠ 未确认计入，继续下一个');
  return false;
}

async function main() {
  while (true) {
    try {
      if (await loop() === 'finished') { log('收工，退出'); return; }
    } catch (e) { log('⚠ 本轮异常，30 秒后继续:', e.message); await sleep(30_000); }
  }
}

async function loop() {
  const target = await ensureTab();

  while (true) {
    const h = await getHours(target);
    if (!h) { log('❌ 接口失败（登录态可能过期），10 分钟后重试'); await sleep(600_000); continue; }
    log(`学时：一般公需 ${h.gen} + 行业公需 ${h.ind} = ${h.sum}`);

    let pick = null;
    for (const type of [3, 1, 2]) {           // 行业公需 → 专业科目 → 一般公需
      const list = await getCourses(target, type);
      if (!list) continue;
      const todo = list.filter(x => x.p < 1);
      if (!todo.length) continue;
      // 按「还要看多久换 1 学时」排序，最省时间的先看
      todo.sort((a, b) => (a.len - Math.min(a.lt, a.len)) / (a.ct || 0.5) - (b.len - Math.min(b.lt, b.len)) / (b.ct || 0.5));
      pick = todo[0];
      log(`剩余 type${type}: ${todo.length} 门`);
      break;
    }
    if (!pick) { log('🎉 全站课件都学完了，收工'); return 'finished'; }

    const r = await playCourse(target, pick);
    if (r === 'done') await waitCredited(target, pick);
    else await sleep(8000);
    state.data.lastId = pick.id;
    state.save();
  }
}

main().catch(e => { log('💥', e.stack); process.exit(1); });
