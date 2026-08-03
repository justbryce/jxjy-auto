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

// hz 的 credited 只有点了「学时重算」才涨，所以它单独看"已学完门数"这个实时指标
const METRICS = [
  ['zj', '浙江工信学时'],
  ['hzDone', '新干线已学完门数'],
  ['nc', '网易云已完成课时'],
];

const now = Date.now();
const cur = await snapshot();
let hist = [];
try { hist = JSON.parse(fs.readFileSync(SNAP, 'utf8')); } catch { }
hist.push({ t: now, ...cur });
hist = hist.filter(x => now - x.t < 24 * 3600_000);      // 只留 24 小时
fs.writeFileSync(SNAP, JSON.stringify(hist, null, 1));

log(METRICS.map(([k, n]) => `${n}=${cur[k] ?? '?'}`).join(' | '));

const old = hist.find(x => now - x.t >= STALE_MIN * 60_000);
if (!old) { log(`（历史不足 ${STALE_MIN} 分钟，先攒数据）`); process.exit(0); }

const stalled = METRICS.filter(([k]) =>
  cur[k] != null && old[k] != null && cur[k] <= old[k]);

if (stalled.length === METRICS.length) {
  const msg = `三个平台 ${STALE_MIN} 分钟内产出都没涨，多半是空转了`;
  log('🚨', msg);
  fs.appendFileSync(path.join(HERE, 'logs/ALERT.log'), `${new Date().toLocaleString('zh-CN')} 🚨 ${msg}\n`);
  try { execSync(`osascript -e 'display notification "${msg}" with title "继续教育自动学习"'`); } catch { }
} else if (stalled.length) {
  const msg = stalled.map(([, n]) => n).join('、') + ` ${STALE_MIN} 分钟没涨`;
  log('⚠', msg);
  fs.appendFileSync(path.join(HERE, 'logs/ALERT.log'), `${new Date().toLocaleString('zh-CN')} ⚠ ${msg}\n`);
} else {
  log('✅ 都在涨');
}
