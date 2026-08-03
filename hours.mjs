#!/usr/bin/env node
// 只读：把三个站点的当前进度打出来。随时可跑，不影响正在学的课。
import * as cdp from './lib/cdp.mjs';
import { evalJson } from './lib/cdp.mjs';

const pick = async (frag) => (await cdp.findTabs(t => t.url.includes(frag)))[0]?.targetId;

// ---- 浙江工信 ----
try {
  const t = await pick('engineer.zjsjczx.org.cn');
  if (!t) throw new Error('没有打开的 tab');
  const r = await evalJson(t, `(async()=>{const k=JSON.parse(localStorage.getItem("JEECGBOOT_PRO__PRODUCTION__3.8.3__COMMON__LOCAL__KEY__")).value.TOKEN__.value;
    const h=await (await fetch("/jeecg-boot/zg/apply/myHours?year="+new Date().getFullYear(),{headers:{"X-Access-Token":k}})).json();
    const o={gen:h.result&&h.result.genclasstime,ind:h.result&&h.result.indclasstime,types:{}};
    for(const n of [1,2,3]){const j=await (await fetch("/jeecg-boot/zg/student/courseware/list?pageNo=1&pageSize=500&zgcZglType="+n,{headers:{"X-Access-Token":k}})).json();
      const rs=(j.result&&j.result.records)||[];
      o.types[n]={all:rs.length,done:rs.filter(x=>x.progress>=1).length,leftSec:rs.filter(x=>x.progress<1).reduce((a,b)=>a+(Number(b.length)-Math.min(Number(b.longesttime||0),Number(b.length))),0)};}
    return JSON.stringify(o)})()`);
  const L = { 1: '专业科目', 2: '一般公需', 3: '行业公需' };
  console.log(`[浙江工信] 一般公需 ${r.gen} + 行业公需 ${r.ind} 学时`);
  for (const n of [1, 2, 3]) if (r.types[n].all)
    console.log(`           ${L[n]}: ${r.types[n].done}/${r.types[n].all} 门，剩余约 ${(r.types[n].leftSec / 3600).toFixed(1)} 小时`);
} catch (e) { console.log('[浙江工信] 取数失败：', e.message); }

// ---- 杭州新干线 ----
try {
  const t = await pick('learning.hzrs.hangzhou.gov.cn');
  if (!t) throw new Error('没有打开的 tab');
  const r = await evalJson(t, `(async()=>{const p=(u,b)=>fetch(u,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(b||{})}).then(x=>x.json());
    const mine=(await p("/api/index/Course/index",{limit:200,page:1})).data.data||[];   // 只剩没学完的，学完就移出这个列表
    const back=(await p("/api/index/Study.UserIndex/index")).data;                      // 学时管理系统后台
    const byType=t=>(back.course||[]).filter(x=>x.coursetype_text===t).reduce((a,b)=>a+Number(b.period),0);
    return JSON.stringify({
      pending:mine.map(x=>x.coursename.slice(0,22)+" "+Math.round(x.validstudytime/x.coursetimes*100)+"%"),
      doneN:(back.course||[]).length, zy:byType("专业课程"), hy:byType("行业公需"), yb:byType("一般公需"),
      official:(back.study||[]).map(x=>x.coursetype+" "+x.s+"/"+x.r)})})()`);
  console.log(`[杭州新干线] 已学完 ${r.doneN} 门 → 专业课程 ${r.zy} + 行业公需 ${r.hy} + 一般公需 ${r.yb} 学时（实时）`);
  console.log(`             官方计入（需 node recalc.mjs 结算）：${r.official.join(' | ')}`);
  if (r.pending.length) console.log(`             进行中：${r.pending.join(' / ')}`);
} catch (e) { console.log('[杭州新干线] 取数失败：', e.message); }

// ---- 网易云课堂 ----
try {
  const t = await pick('study.163.com');
  if (!t) throw new Error('没有打开的 tab');
  const r = await evalJson(t, `(async()=>{const tk=(document.cookie.match(/(?:^|;\\s*)NTESSTUDYSI=([^;]+)/)||[])[1]||"";
    const out=[];
    for(let p=1;p<=10;p++){
      const q=await fetch("/j/my/courseListV2.json?pageSize=20&pageIndex="+p+"&keyword=&filterType=0&t="+Date.now(),
        {headers:{"edu-script-token":tk,"Accept":"application/json"}});
      if(!q.ok) return JSON.stringify({err:q.status});
      const j=await q.json();
      if(j&&(j.code===-2||j.message==="not_auth")) return JSON.stringify({err:"登录态失效（not_auth）"});
      const L=(j.result&&j.result.list)||[];
      out.push(...L.map(x=>({name:x.name,units:x.units,fin:x.finishedUnits})));
      if(p>=((j.result&&j.result.query&&j.result.query.totlePageCount)||1))break;}
    return JSON.stringify({list:out})})()`);
  if (r.err) throw new Error('接口 ' + r.err);
  const units = r.list.reduce((a, b) => a + b.units, 0), fin = r.list.reduce((a, b) => a + b.fin, 0);
  console.log(`[网易云课堂] 课时 ${fin}/${units} 已完成（${r.list.length} 门课）`);
  for (const c of r.list) console.log(`             ${c.fin}/${c.units}  ${c.name}`);
} catch (e) { console.log('[网易云课堂] 取数失败：', e.message); }
