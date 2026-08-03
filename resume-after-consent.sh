#!/bin/bash
# 等 Chrome 的「要允许远程调试吗？」被人点掉，然后自动把整套恢复起来。
#
# 为什么需要它：Chrome 136+ 的远程调试授权是**按浏览器实例**给的，存在内存里。
# Chrome 一崩溃/重启，授权就没了，下次有人连调试端口时会弹这个对话框，
# **必须有人在机器上点「允许」**，脚本点不动（合成点击需要辅助功能权限，
# 而这台机器上跑脚本的终端没有）。
# 于是就有了这个守候脚本：人点完之后不用做别的，它自己会把三个站重新跑起来。
#
# 用法：nohup ./resume-after-consent.sh > logs/resume.log 2>&1 &

cd "$(dirname "$0")" || exit 1
LOG() { echo "$(date '+%Y-%m-%d %H:%M:%S') $*"; }

LOG "开始等待 Chrome 远程调试授权（每 20 秒探一次，最多等 12 小时）"

# ⚠️ 别探太勤：**每次连接尝试都会新弹一个授权框**，堆一叠上去，人点掉一个后面还有一个，
# 看起来像"点了没用"。2 分钟一次足够，且保证对话框始终有一个在。
for i in $(seq 1 360); do
  curl -s --max-time 15 http://localhost:3456/targets -o /dev/null 2>/dev/null
  H=$(curl -s --max-time 10 http://localhost:3456/health 2>/dev/null)
  case "$H" in
    *'"connected":true'*)
      LOG "✅ CDP 通了：$H"
      LOG "清掉暂停标记，重建窗口布局……"
      rm -f state/PAUSED
      # shellcheck disable=SC1091
      [ -f env.local ] && . ./env.local
      node setup-windows.mjs 2>&1 | sed 's/^/  | /'
      LOG "启动 runner"
      ./start.sh 2>&1 | grep -E '✅|❌' | sed 's/^/  | /'
      LOG "🎉 全部恢复完成"
      exit 0
      ;;
  esac
  [ $((i % 5)) -eq 0 ] && LOG "还没授权（已等 $((i * 2)) 分钟）"
  sleep 120
done

LOG "❌ 等了 12 小时还没授权，放弃。人工处理：在 Chrome 里点「允许」后跑 ./pause.sh off"
