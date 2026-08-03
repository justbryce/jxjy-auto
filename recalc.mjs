#!/usr/bin/env node
// 杭州新干线「学时重算」。
//
// 🔑 关键：课程学完（validstudytime 满）**不会自动计入学时**，必须在学时管理系统后台点「学时重算」。
//    平台限制每天最多 3 次，所以 cron 每天只跑 2 次（早 8 点 / 晚 8 点），留一次给手动。
//
// 坑：「学时重算」按钮只吃 JS 的 el.click()，真实鼠标 clickAt 点不出确认弹窗（顶部有固定头挡着）。
//    确认弹窗里的「确定」同理。整个流程页面不发任何 XHR（服务端异步跑），点完等几秒再查数即可。

import * as cdp from './lib/cdp.mjs';
import { sleep, evalJs, evalJson } from './lib/cdp.mjs';

const ORIGIN = 'https://learning.hzrs.hangzhou.gov.cn';
const log = cdp.makeLogger('recalc');

const summary = t => evalJson(t, `(async()=>{const j=await (await fetch("/api/index/Study.UserIndex/index",
  {method:"POST",headers:{"Content-Type":"application/json"},body:"{}"})).json();
  return JSON.stringify((j.data.study||[]).map(x=>({t:x.coursetype,s:Number(x.s)||0,r:Number(x.r)||0})))})()`);

const fmt = a => a.map(x => `${x.t} ${x.s}/${x.r || '—'}`).join(' | ');

async function main() {
  // 用自己的临时 tab，别动 runner 的控制 tab
  const { targetId: t } = await cdp.newTab(`${ORIGIN}/#/backIndex`);
  try {
    await sleep(9000);
    const before = await summary(t);
    if (!before) { log('❌ 读不到学时（登录态过期？）'); return; }
    log('重算前：', fmt(before));

    const opened = await evalJs(t, `(()=>{const b=[...document.querySelectorAll("button")].find(x=>/学时重算/.test(x.innerText));
      if(!b) return 0; b.click(); return 1})()`);
    if (!opened) { log('❌ 找不到「学时重算」按钮'); return; }
    await sleep(3000);

    const ok = await evalJs(t, `(()=>{const b=document.querySelector(".el-message-box");if(!b)return 0;
      const o=[...b.querySelectorAll("button")].find(x=>x.innerText.trim()==="确定");
      if(!o) return 0; o.click(); return 1})()`);
    if (!ok) { log('❌ 确认弹窗没出来或没有「确定」'); return; }

    await sleep(12000);
    const after = await summary(t);
    log('重算后：', fmt(after));
    const d = after.find(x => x.t === '总学时')?.s - (before.find(x => x.t === '总学时')?.s ?? 0);
    log(d > 0 ? `✅ 新计入 ${d.toFixed(1)} 学时` : '（本次没有新增）');
  } finally {
    await cdp.closeTab(t).catch(() => { });
  }
}

main().catch(e => { log('💥', e.message); process.exit(1); });
