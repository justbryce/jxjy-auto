#!/bin/bash
# 一眼看清三个站点的进度
cd "$(dirname "$0")"

for s in zjsjczx hzrs study163; do
  if pgrep -f "runners/$s.mjs" >/dev/null; then
    printf "✅ %-9s 运行中 (pid %s)\n" "$s" "$(pgrep -f "runners/$s.mjs" | tr '\n' ' ')"
  else
    printf "❌ %-9s 已停止\n" "$s"
  fi
  [ -f "logs/$s.log" ] && tail -4 "logs/$s.log" | sed 's/^/     /'
  echo
done

echo "—— 学时汇总 ——"
node hours.mjs 2>/dev/null || echo "(hours.mjs 取数失败，多半是 Chrome 里登录态过期了)"
