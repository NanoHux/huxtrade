#!/bin/bash
set -euo pipefail
cd /Users/hux/Desktop/huxtrade
exec python3 scripts/tg-say.py "$@"
