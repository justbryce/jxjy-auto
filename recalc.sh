#!/bin/bash
# cron 入口：自己 cd 到项目目录再跑（cron 的 cwd 是 $HOME，相对路径会失效）
cd "$(dirname "$0")" || exit 1
mkdir -p logs state
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
node recalc.mjs >> logs/recalc.log 2>&1
