#!/bin/bash
# 看门狗：进程挂了拉起来，日志超过 STUCK_MIN 分钟没动静就判定卡死重启。
# 由 cron 每 5 分钟跑一次。
cd "$(dirname "$0")" || exit 1
mkdir -p logs state
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
STUCK_MIN=25
WLOG=logs/watchdog.log
ts() { date '+%Y-%m-%d %H:%M:%S'; }

# CDP 代理必须活着（不重启已有的）
CDP_PROXY="${CDP_PROXY:-http://localhost:3456}"
if ! curl -sf -m 5 "$CDP_PROXY/health" >/dev/null 2>&1; then
  echo "$(ts) CDP 代理不通，拉起仓库自带的" >> "$WLOG"
  CDP_PORT="${CDP_PROXY##*:}"; [[ "$CDP_PORT" =~ ^[0-9]+$ ]] || CDP_PORT=3456
  PORT="$CDP_PORT" nohup node tools/cdp-proxy.mjs >> logs/cdp-proxy.log 2>&1 &
  sleep 2
fi

for s in zjsjczx hzrs study163; do
  log="logs/$s.log"
  if ! pgrep -f "runners/$s.mjs" >/dev/null; then
    # 正常收工（跑完了）就别再拉起来
    if [ -f "$log" ] && tail -3 "$log" | grep -q "收工，退出\|所有课程都学完"; then continue; fi
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
