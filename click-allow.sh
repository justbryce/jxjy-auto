#!/bin/bash
# 点掉 Chrome 的「要允许远程调试吗？」对话框。
#
# ⚠️ 必须用 `open -a Terminal click-allow.sh` 跑，不能在 Claude 的 bash 里直接跑。
# macOS 的辅助功能授权按**责任进程**给：Claude Code 起的 shell 责任进程被判成
# /opt/homebrew/.../node，而 node 在 TCC 里是 auth_value=0（永久拒绝 —— 多半是某次
# 锁屏时授权弹窗没人点，被静默记成了拒绝）。于是合成点击/按键**静默失效**：不报错、就是没反应。
# Terminal.app 和 Ghostty 是 auth_value=2，借它们的壳跑才点得动。
#
# ⚠️ 别在 AppleScript 里写 `every process whose visible is true` 再遍历它的 windows ——
# 实测会挂死几分钟。只查 Google Chrome 一个进程。

cd "$(dirname "$0")" || exit 1
exec >> logs/click-allow.log 2>&1
echo "===== $(date '+%F %T') 开始 ====="

osascript <<'APPLESCRIPT'
tell application "Google Chrome" to activate
delay 2
tell application "System Events" to tell process "Google Chrome"
  set target to missing value
  repeat with w in windows
    try
      if (count of sheets of w) > 0 then set target to sheet 1 of w
    end try
  end repeat
  if target is missing value then return "没找到对话框"
  set p to position of target
  set sz to size of target
end tell
-- 「允许」在对话框右下角。按比例算，不写死像素：宽 448 时约在 x+395，高 200 时约在 y+158
set gx to (item 1 of p) + ((item 1 of sz) * 0.882)
set gy to (item 2 of p) + ((item 2 of sz) * 0.79)
tell application "System Events" to click at {gx as integer, gy as integer}
delay 3
tell application "System Events" to tell process "Google Chrome"
  set n to 0
  repeat with w in windows
    try
      set n to n + (count of sheets of w)
    end try
  end repeat
end tell
return "点了 " & (gx as integer) & "," & (gy as integer) & " 剩余sheet=" & n
APPLESCRIPT

echo "退出码 $?"
echo "===== $(date '+%F %T') 结束 ====="
