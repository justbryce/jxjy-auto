#!/usr/bin/env node
// 结果导向的看门狗：只看「三个平台上外部可验证的产出」有没有在涨。
//
// 由来：2026-08-03 凌晨连续踩了两个"静默空转"型 bug ——
//   · 新干线对早已拿过学分的课秒判完成 → 同一门课 60 秒一轮无限重开，8 小时零产出；
//   · 163 播完后读的是开播前那份旧目录快照 → 同一课时重播 3 遍才放弃。
// 两次的症状完全一样：进程活着、日志刷得飞快、CPU 也在忙，但**真实学时一点没涨**。
// 进程级看门狗（watchdog.sh）对这种情况完全无感，所以必须单独盯产出。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import * as cdp from './lib/cdp.mjs';
import { evalJson } from './lib/cdp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SNAP = path.join(HERE, 'state/progress.json');
const STALE_MIN = Number(process.env.STALE_MIN || 90);   // 多久没涨就报警
const log = cdp.makeLogger('progress');
const pick = async frag => (await cdp.findTabs(t => t.url.includes(frag)))[0]?.targetId;

async function snapshot() {
  const out = {};
  try {
    const t = await pick('engineer.zjsjczx.org.cn');
    const r = await evalJson(t, `(async()=>{const k=JSON.parse(localStorage.getItem("JEECGBOOT_PRO__PRODUCTION__3.8.3__COMMON__LOCAL__KEY__")).value.TOKEN__.value;
      const h=await (await fetch("/jeecg-boot/zg/apply/myHours?year="+new Date().getFullYear(),{headers:{"X-Access-Token":k}})).json();
      return JSON.stringify((Number(h.result.genclasstime)||0)+(Number(h.result.indclasstime)||0))})()`);
    out.zj = Number(r);
  } catch { }
  try {
    const t = await pick('learning.hzrs.hangzhou.gov.cn');
    const r = await evalJson(t, `(async()=>{const j=await (await fetch("/api/index/Study.UserIndex/index",
      {method:"POST",headers:{"Content-Type":"application/json"},body:"{}"})).json();
      const s=(j.data.study||[]).find(x=>x.coursetype==="总学时");
      return JSON.stringify({credited:Number(s&&s.s)||0,doneN:(j.data.course||[]).length})})()`);
    out.hz = r?.credited; out.hzDone = r?.doneN;
  } catch { }
  try {
    const t = await pick('study.163.com');
    const r = await evalJson(t, `(async()=>{const tk=(document.cookie.match(/(?:^|;\\s*)NTESSTUDYSI=([^;]+)/)||[])[1]||"";
      let fin=0;
      for(let p=1;p<=10;p++){
        const q=await fetch("/j/my/courseListV2.json?pageSize=20&pageIndex="+p+"&keyword=&filterType=0&t="+Date.now(),
          {headers:{"edu-script-token":tk,"Accept":"application/json"}});
        if(!q.ok) return JSON.stringify(null);
        const j=await q.json(); const L=(j.result&&j.result.list)||[];
        fin+=L.reduce((a,b)=>a+(b.finishedUnits||0),0);
        if(p>=((j.result&&j.result.query&&j.result.query.totlePageCount)||1))break;}
      return JSON.stringify(fin)})()`);
    if (r != null) out.nc = Number(r);
  } catch { }
  return out;
}

// 第三列 = 这个指标"多久没涨才算不正常"，单位分钟。**不同指标的更新节奏差一个数量级，
// 不能共用一个窗口**。
//
// 🔴 新干线原来看的是 `data.course.length`（已学完门数）—— 那是个**死指标**：
// 平台把这个列表截断到 8 条，学完再多也永远返回 8。结果它从 2026-08-03 中午一直报警到凌晨，
// 报了 20 多条，而同期新干线的学时其实从 16 涨到了 49。
// 假警报比没有警报更糟：它把真出事时的那一条淹掉了。
// 现在改看 `data.study` 里「总学时」的 s（权威值），代价是它只在「学时重算」之后才跳
// （recalc.sh 每天 8:05 / 20:05 各跑一次，平台限 3 次/天），所以窗口给到 12 小时。
// 停用的站（state/DISABLED-<站名>）不参与告警 —— 它本来就不该涨。
// 不加这个的话，人主动停掉一个站之后，90 分钟就开始刷"没涨"的假警报。
const disabled = k => fs.existsSync(path.join(HERE, 'state', `DISABLED-${k}`));

const METRICS = [
  ['zj', '浙江工信学时', STALE_MIN, 'zjsjczx'],
  ['hz', '新干线总学时', 12 * 60, 'hzrs'],
  ['nc', '网易云已完成课时', STALE_MIN, 'study163'],
].filter(m => !disabled(m[3]));

const now = Date.now();
const cur = await snapshot();
let hist = [];
try { hist = JSON.parse(fs.readFileSync(SNAP, 'utf8')); } catch { }
hist.push({ t: now, ...cur });
hist = hist.filter(x => now - x.t < 24 * 3600_000);      // 只留 24 小时
fs.writeFileSync(SNAP, JSON.stringify(hist, null, 1));

log(METRICS.map(([k, n]) => `${n}=${cur[k] ?? '?'}`).join(' | '));

// 每个指标按自己的窗口回看
const stalled = METRICS.filter(([k, , win]) => {
  const old = hist.find(x => now - x.t >= win * 60_000);
  return old && cur[k] != null && old[k] != null && cur[k] <= old[k];
});
if (!hist.find(x => now - x.t >= STALE_MIN * 60_000)) {
  log(`（历史不足 ${STALE_MIN} 分钟，先攒数据）`); process.exit(0);
}

if (stalled.length === METRICS.length) {
  const msg = `在跑的 ${METRICS.length} 个平台产出都没涨，多半是空转了`;
  log('🚨', msg);
  fs.appendFileSync(path.join(HERE, 'logs/ALERT.log'), `${new Date().toLocaleString('zh-CN')} 🚨 ${msg}\n`);
  try { execSync(`osascript -e 'display notification "${msg}" with title "继续教育自动学习"'`); } catch { }
} else if (stalled.length) {
  const msg = stalled.map(([, n, w]) => `${n} ${w >= 60 ? (w / 60) + ' 小时' : w + ' 分钟'}没涨`).join('、');
  log('⚠', msg);
  fs.appendFileSync(path.join(HERE, 'logs/ALERT.log'), `${new Date().toLocaleString('zh-CN')} ⚠ ${msg}\n`);
} else {
  log('✅ 都在涨');
}
