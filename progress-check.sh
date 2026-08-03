#!/bin/bash
cd "$(dirname "$0")" || exit 1
mkdir -p logs state
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
node progress-check.mjs >> logs/progress.log 2>&1
