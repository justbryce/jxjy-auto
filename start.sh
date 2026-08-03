#!/bin/bash
# 启动（或补齐）三个站点的 runner。已在跑的不会重复启动。
cd "$(dirname "$0")"
mkdir -p logs state

# 本机私有配置（不进 git）。放你自己的 EXPOSE / NC_CONCURRENCY / 端口之类。
# 例：  echo 'export EXPOSE=lan' > env.local
[ -f ./env.local ] && . ./env.local

# CDP 代理：已经有一个在跑就用它（比如你自己另外起的），没有就拉起仓库自带的那个。
CDP_PROXY="${CDP_PROXY:-http://localhost:3456}"
if curl -sf -m 3 "$CDP_PROXY/health" >/dev/null 2>&1; then
  echo "· CDP 代理已在运行 ($CDP_PROXY)"
else
  CDP_PORT="${CDP_PROXY##*:}"; [[ "$CDP_PORT" =~ ^[0-9]+$ ]] || CDP_PORT=3456
  PORT="$CDP_PORT" nohup node tools/cdp-proxy.mjs >> logs/cdp-proxy.log 2>&1 &
  sleep 2
  if curl -sf -m 5 "$CDP_PROXY/health" >/dev/null 2>&1; then
    echo "✅ CDP 代理已启动 ($CDP_PROXY)"
  else
    echo "❌ CDP 代理起不来。检查：① Chrome 是否开了远程调试"
    echo "   （地址栏 chrome://inspect/#remote-debugging 勾选 Allow remote debugging，可能需重启 Chrome）"
    echo "   ② 详见 logs/cdp-proxy.log"
    exit 1
  fi
fi
export CDP_PROXY

# hzrs 的学时纯按「页面开着的墙钟时间」计，视频播不播都一样；
# 而 zjsjczx / 163 必须真播。Chrome 里同时播的视频越多，每路速率越低（实测 163 从 100% 掉到 21%），
# 所以默认不让 hzrs 占用带宽。想让它也真播视频：HZ_PLAY_VIDEO=1 ./start.sh hzrs
export HZ_PLAY_VIDEO="${HZ_PLAY_VIDEO:-0}"
# worker 数要和 setup-windows.mjs 建的窗口数一致（每个 worker 一个独立可见窗口才能跑满 1x）。
# 改这里之后记得跑：NC_CONCURRENCY=<n> node setup-windows.mjs
export NC_CONCURRENCY="${NC_CONCURRENCY:-3}"

start() {
  local name=$1
  if pgrep -f "runners/$name.mjs" >/dev/null; then
    echo "· $name 已在运行 (pid $(pgrep -f "runners/$name.mjs" | tr '\n' ' '))"
  else
    nohup caffeinate -is node "runners/$name.mjs" >> "logs/$name.log" 2>&1 &
    echo "✅ $name 已启动 (pid $!)"
  fi
}

# 汇总面板
if ! pgrep -f "node dashboard.mjs" >/dev/null; then
  nohup node dashboard.mjs >> logs/dashboard.log 2>&1 &
  echo "✅ dashboard 已启动 → http://localhost:8848"
else
  echo "· dashboard 已在运行 → http://localhost:8848"
fi

# 可见性自愈守护进程。**必须由这里拉起，不能交给 cron** ——
# 它要用 osascript 建窗口，而 macOS 的 Apple Events 授权按"责任进程"给，
# cron/launchd 起的进程会卡在一个没人看得见的授权弹窗上直到超时。
# 详见 heal-visibility.mjs 顶部注释。
if ! pgrep -f "heal-visibility.mjs --daemon" >/dev/null; then
  nohup node heal-visibility.mjs --daemon >> logs/heal.log 2>&1 &
  echo "✅ 可见性自愈守护 已启动"
else
  echo "· 可见性自愈守护 已在运行"
fi

SITES=("$@")
[ ${#SITES[@]} -eq 0 ] && SITES=(zjsjczx hzrs study163)
for s in "${SITES[@]}"; do start "$s"; done
echo
echo "看日志： tail -f $(pwd)/logs/<站点>.log"
echo "看状态： $(pwd)/status.sh"
