#!/bin/bash
# 维护开关：停下所有 runner，并且**让 cron 看门狗别再把它们拉起来**。
# 没有这个的话，你手动 pkill 完最多 5 分钟就会被 watchdog.sh 自动重启 ——
# 人在给平台重新登录、或者在调窗口布局的时候被突然拉起来的 runner 打断，很难受。
#   ./pause.sh        暂停
#   ./pause.sh off    恢复（并立刻启动）
cd "$(dirname "$0")" || exit 1
FLAG=state/PAUSED
mkdir -p state
if [ "$1" = "off" ]; then
  rm -f "$FLAG"
  echo "▶️  已解除暂停"
  exec ./start.sh
fi
date '+%Y-%m-%d %H:%M:%S' > "$FLAG"
pkill -f "heal-visibility.mjs --daemon"; rm -f state/heal.pid
pkill -f "runners/"
sleep 2
echo "⏸  已暂停：runner 全停，看门狗不会再拉起（标记文件 $FLAG）"
echo "   恢复：./pause.sh off"
pgrep -fl "runners/" | grep -v caffeinate || echo "   ✅ 确认没有 runner 在跑"
