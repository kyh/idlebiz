#!/usr/bin/env bash
# Kill everything `pnpm dev:desktop` starts, and free the CDP port (9222). Idempotent.
#
# Order matters: the supervisors (turbo watch, electron-vite) go FIRST. Kill the app on
# its own and electron-vite just restarts it.
#
# Every pattern is anchored to this repo's absolute path, so a dev server in another
# checkout — or any other Electron app you have open — survives.
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
SELF=$$

# outermost to innermost; pgrep -f matches against the whole command line
PATTERNS=(
  "$ROOT/node_modules/.bin/../turbo"    # turbo shim
  "$ROOT/node_modules/.pnpm/@turbo"     # turbo watch dev
  "$ROOT/apps/desktop/node_modules"     # electron-vite dev server
  "$ROOT/node_modules/.pnpm/electron@"  # the Electron app + its helper processes
  "$ROOT/node_modules/.pnpm/@esbuild"   # esbuild service
)

killed=0
for pattern in "${PATTERNS[@]}"; do
  for pid in $(pgrep -f -- "$pattern" 2>/dev/null || true); do
    [ "$pid" = "$SELF" ] && continue
    kill -9 "$pid" 2>/dev/null && killed=$((killed + 1))
  done
done

# whatever still holds the debug port, whoever it belongs to
for pid in $(lsof -ti tcp:9222 2>/dev/null || true); do
  kill -9 "$pid" 2>/dev/null && killed=$((killed + 1))
done

n=0
while lsof -ti tcp:9222 >/dev/null 2>&1 && [ $n -lt 30 ]; do
  sleep 0.2
  n=$((n + 1))
done

port=free
lsof -ti tcp:9222 >/dev/null 2>&1 && port=BUSY
left=$(pgrep -fc -- "$ROOT/node_modules/.pnpm/electron@" 2>/dev/null || true)
echo "devkill: killed $killed; port 9222 $port; electron left: ${left:-0}"
[ "$port" = free ] && [ "${left:-0}" -eq 0 ]
