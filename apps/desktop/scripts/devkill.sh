#!/usr/bin/env bash
# Stop everything `pnpm dev:desktop` starts, and free the CDP port (9222). Idempotent.
#
# Order matters: the supervisors (turbo watch, electron-vite) go FIRST. Kill the app on
# its own and electron-vite just restarts it.
#
# Every pattern is anchored to this repo's absolute path and to the desktop session, so
# `pnpm dev:web`, `pnpm verify`, tests and `pnpm e2e`'s app here, a dev server in another
# checkout — or any other Electron app you have open — survive. The binary's path alone
# would take e2e's app too: Playwright launches the same Electron.
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
SELF=$$

# outermost to innermost; pgrep -f matches the whole command line as an extended regex.
# No esbuild pattern: its service exits when electron-vite's stdin pipe closes, and a
# path match would also take the one vitest or a build is using.
PATTERNS=(
  "$ROOT/node_modules/\.bin/\.\./turbo/bin/turbo watch dev .*@repo/desktop"  # turbo shim
  "$ROOT/node_modules/\.pnpm/@turbo.*/bin/turbo watch dev .*@repo/desktop"   # turbo watch dev
  "$ROOT/apps/desktop/node_modules/.*/electron-vite\.js dev"                 # electron-vite dev server
  "$ROOT/node_modules/\.pnpm/electron@.* --remote-debugging-port=9222( |$)"  # the dev app, if electron-vite is gone
)

descendants() {
  local child
  for child in $(pgrep -P "$1" 2>/dev/null || true); do
    echo "$child"
    descendants "$child"
  done
}

# each match with everything under it: electron-vite's Electron and its helper processes
session() {
  local pattern pid
  for pattern in "${PATTERNS[@]}"; do
    for pid in $(pgrep -f -- "$pattern" 2>/dev/null || true); do
      [ "$pid" = "$SELF" ] && continue
      echo "$pid"
      descendants "$pid"
    done
  done
}

# TERM first so Electron can finish the write it is in the middle of (the save is
# markdown packages and an append-only log); KILL whatever is still there after.
targets=()
for pid in $(session); do
  targets+=("$pid")
done
# the debug port's holder too, but only if it is this checkout's: a Chrome you are
# driving over 9222 is not ours to kill
for pid in $(lsof -ti tcp:9222 2>/dev/null || true); do
  if ps -o args= -p "$pid" 2>/dev/null | grep -qF -- "$ROOT"; then
    targets+=("$pid")
  else
    echo "devkill: port 9222 is held by pid $pid, not from this checkout — leaving it" >&2
  fi
done

any_alive() {
  for pid in "${targets[@]:-}"; do
    [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null && return 0
  done
  return 1
}

killed=0
for pid in "${targets[@]:-}"; do
  [ -n "$pid" ] && kill -TERM "$pid" 2>/dev/null && killed=$((killed + 1))
done
n=0
while any_alive && [ $n -lt 15 ]; do
  sleep 0.2
  n=$((n + 1))
done
for pid in "${targets[@]:-}"; do
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null && kill -9 "$pid" 2>/dev/null
done

n=0
while lsof -ti tcp:9222 >/dev/null 2>&1 && [ $n -lt 30 ]; do
  sleep 0.2
  n=$((n + 1))
done

port=free
lsof -ti tcp:9222 >/dev/null 2>&1 && port=BUSY
left=$(session | wc -l | tr -d ' ')
echo "devkill: killed $killed; port 9222 $port; session left: ${left:-0}"
[ "$port" = free ] && [ "${left:-0}" -eq 0 ]
