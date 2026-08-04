#!/bin/bash
# 看门狗：进程挂了拉起来，日志超过 STUCK_MIN 分钟没动静就判定卡死重启。
# 由 cron 每 5 分钟跑一次。
cd "$(dirname "$0")" || exit 1
mkdir -p logs state
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
STUCK_MIN=25

# 维护暂停：./pause.sh 建了这个标记就什么都别做。
# 否则人在重新登录平台 / 调窗口布局的时候，会被本脚本 5 分钟一次地把 runner 拉起来打断。
if [ -f state/PAUSED ]; then exit 0; fi
WLOG=logs/watchdog.log
ts() { date '+%Y-%m-%d %H:%M:%S'; }

# CDP 代理必须活着（不重启已有的）
CDP_PROXY="${CDP_PROXY:-http://localhost:3456}"
# 代理进程活着、但连不上 Chrome —— 这种情况下三个 runner 只会一直 timeout 空转。
# 典型原因：代理重连时 Chrome 弹了「允许调试」授权框，而机器锁屏没人点
# （那个同意状态是 per-instance 的内存标志，Chrome 配置里没有持久化，只能人工点）。
HEALTH=$(curl -sf -m 5 "$CDP_PROXY/health" 2>/dev/null)
if [ -n "$HEALTH" ] && ! echo "$HEALTH" | grep -q '"connected":true'; then
  echo "$(ts) 🚨 CDP 代理活着但连不上 Chrome（多半是授权弹窗没人点 / 机器锁屏）" >> logs/ALERT.log
  osascript -e 'display notification "CDP 代理连不上 Chrome，请解锁机器并在 Chrome 里点「允许」调试授权" with title "继续教育自动学习"' 2>/dev/null
fi

if ! curl -sf -m 5 "$CDP_PROXY/health" >/dev/null 2>&1; then
  echo "$(ts) CDP 代理不通，拉起仓库自带的" >> "$WLOG"
  CDP_PORT="${CDP_PROXY##*:}"; [[ "$CDP_PORT" =~ ^[0-9]+$ ]] || CDP_PORT=3456
  PORT="$CDP_PORT" nohup node tools/cdp-proxy.mjs >> logs/cdp-proxy.log 2>&1 &
  sleep 2
fi

for s in zjsjczx hzrs study163; do
  log="logs/$s.log"
  if ! pgrep -f "runners/$s.mjs" >/dev/null; then
    # 正常收工（跑完了）就别再拉起来 —— 但**只认 6 小时**。
    # 🔴 2026-08-04 踩过：hzrs 在登录态失效时把空列表读成"什么都不缺"，打了「收工，退出」，
    #    而这条规则让看门狗**永远**不再拉它，等于一次误判 = 永久停摆。
    #    runner 那边已经加了"总学时要求恒为 90，读到 0 就是没读到账号"的守卫，这里再兜一层：
    #    过了 6 小时无条件重试一次。真学完的话它会立刻再退出，代价可以忽略。
    if [ -f "$log" ] && tail -3 "$log" | grep -q "收工，退出\|所有课程都学完"; then
      quit_age=$(( ( $(date +%s) - $(stat -f %m "$log") ) / 3600 ))
      if [ "$quit_age" -lt 6 ]; then continue; fi
      echo "$(ts) $s 已收工 ${quit_age} 小时，复查一次（防止是误判的收工）" >> "$WLOG"
    fi
    echo "$(ts) $s 不在运行，拉起" >> "$WLOG"
    ./start.sh "$s" >> "$WLOG" 2>&1
    continue
  fi
  # 卡死检测：日志 mtime 太久没更新
  if [ -f "$log" ]; then
    age=$(( ( $(date +%s) - $(stat -f %m "$log") ) / 60 ))
    if [ "$age" -ge "$STUCK_MIN" ]; then
      echo "$(ts) $s 日志 ${age} 分钟没动静，判定卡死，重启" >> "$WLOG"
      pkill -f "runners/$s.mjs"
      sleep 3
      ./start.sh "$s" >> "$WLOG" 2>&1
    fi
  fi
done

# 可见性自愈守护进程：只检查它活着，自愈本身由 start.sh 拉起的常驻进程来做
# （日志集中、不受 cron 环境差异影响）。详见 heal-visibility.mjs 顶部注释。
if ! pgrep -f "heal-visibility.mjs --daemon" >/dev/null; then
  echo "$(ts) ⚠️ 可见性自愈守护不在运行 —— 需要在已授权的终端里执行 ./start.sh 把它拉起来" >> logs/ALERT.log
  osascript -e 'display notification "可见性自愈守护挂了，请在终端跑 ./start.sh" with title "继续教育自动学习"' 2>/dev/null
fi

# 汇总面板
if ! pgrep -f "node dashboard.mjs" >/dev/null; then
  echo "$(ts) dashboard 不在运行，拉起" >> "$WLOG"
  nohup node dashboard.mjs >> logs/dashboard.log 2>&1 &
fi

# 登录态失效告警
for s in zjsjczx hzrs study163; do
  if [ -f "logs/$s.log" ] && tail -20 "logs/$s.log" | grep -q "登录态"; then
    echo "$(ts) ⚠️ $s 疑似登录态失效" >> logs/ALERT.log
    osascript -e "display notification \"$s 登录态可能过期，需要重新登录\" with title \"继续教育自动学习\"" 2>/dev/null
  fi
done

# 日志轮转：单个日志超过 20MB 就截断保留尾部 5000 行（这活儿要跑好几天，别把盘撑爆）
for f in logs/*.log; do
  [ -f "$f" ] || continue
  sz=$(stat -f %z "$f")
  if [ "$sz" -gt 20971520 ]; then
    tail -5000 "$f" > "$f.tmp" && mv "$f.tmp" "$f"
    echo "$(ts) 轮转日志 $f" >> "$WLOG"
  fi
done

# 弹窗截图清理：只留最近 20 张（早期误报攒了一堆几 MB 的图）
ls -t logs/*.png 2>/dev/null | tail -n +21 | while read -r f; do rm -f "$f"; done

# front.lock 死锁清理（持有超过 3 分钟一定是异常）
if [ -f state/front.lock ]; then
  age=$(( $(date +%s) - $(stat -f %m state/front.lock) ))
  [ "$age" -gt 180 ] && { rm -f state/front.lock; echo "$(ts) 清理死锁 front.lock" >> "$WLOG"; }
fi

# 内存告警。2026-08-04 凌晨整台机器把内存刷爆，macOS 弹「应用程序内存不足」，
# **Chrome 浏览器主进程直接死锁**，三个站全停 6 小时 —— 而当时**没有任何监控会提前发现**。
#
# ⚠️ 挑指标踩了两次坑，别再重挑：
#   · `memory_pressure` 的 "free percentage"：事故当时还报 32%，因为它把 inactive 算成可用。没用。
#   · vm_stat 的 `Pages free`：**平时就只有几十 MB**（macOS 故意压低，inactive 才是可回收缓存），
#     拿它做阈值会永远在响 —— 而假警报比没有警报更糟（见 AGENTS.md 第二类）。
#   · ✅ 用 Apple 自己的 `kern.memorystatus_vm_pressure_level`：1=正常 2=警告 4=危急。
#     swap 百分比**只能当最后兜底**（阈值 97%）：macOS 会动态扩 swap，
#     所以"已用 92%"经常只是它还没扩容，17 分钟后自己就降到 52% 了 —— 实测误报过一次。
# 这里只告警不动手：内存紧张时自动去停 runner，风险比收益大（见 AGENTS.md 第三类）。
LVL=$(sysctl -n kern.memorystatus_vm_pressure_level 2>/dev/null)
SWAP_PCT=$(sysctl -n vm.swapusage 2>/dev/null | awk '{t=0;u=0; for(i=1;i<=NF;i++){ if($i=="total"){gsub(/M/,"",$(i+2)); t=$(i+2)} if($i=="used"){gsub(/M/,"",$(i+2)); u=$(i+2)} } if(t>0) printf "%d", u*100/t; else print 0}')
# ⚠️ 等级 2（warning）在这台 16G 机器上是**常态**，每 5 分钟报一次就成噪音了。
#    分档：等级 4（critical）立刻报；等级 2 要**连续 3 次（15 分钟）**才报，且每小时最多一次。
MEMSTATE=state/mem.streak
STREAK=$(cat "$MEMSTATE" 2>/dev/null || echo 0)
if [ -n "$LVL" ] && [ "$LVL" -ge 2 ] 2>/dev/null; then STREAK=$((STREAK+1)); else STREAK=0; fi
echo "$STREAK" > "$MEMSTATE"
FIRE=0
[ -n "$LVL" ] && [ "$LVL" -ge 4 ] 2>/dev/null && FIRE=1                       # 危急：立刻
[ "$STREAK" -ge 3 ] && FIRE=1                                                  # 警告持续 15 分钟
[ -n "$SWAP_PCT" ] && [ "$SWAP_PCT" -ge 97 ] 2>/dev/null && FIRE=1             # swap 见底兜底
if [ "$FIRE" = 1 ]; then
  LASTF=state/mem.lastalert
  LAST=$(cat "$LASTF" 2>/dev/null || echo 0)
  NOW=$(date +%s)
  if [ "$LVL" -ge 4 ] 2>/dev/null || [ $((NOW-LAST)) -ge 3600 ]; then
    echo "$NOW" > "$LASTF"
    MSG="内存压力等级 ${LVL}（已持续 ${STREAK} 轮 ≈ $((STREAK*5)) 分钟），swap 已用 ${SWAP_PCT}% —— 再下去 Chrome 主进程会死锁（8/4 凌晨那次就是），考虑调小 NC_CONCURRENCY 或关掉别的 App"
    echo "$(ts) 🚨 $MSG" >> logs/ALERT.log
    osascript -e "display notification \"内存压力 ${LVL} 持续 $((STREAK*5)) 分钟 / swap ${SWAP_PCT}%\" with title \"继续教育自动学习\"" 2>/dev/null
  fi
fi
