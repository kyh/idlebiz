#!/usr/bin/env bash
# Stop everything `pnpm dev:desktop` and `pnpm dev:browser` start, and free the dev server's port
# (31100). Idempotent.
#
# Order matters: the supervisor (`tauri dev`) goes FIRST. Kill the shell on its own and `tauri dev`
# just starts it again.
#
# Every pattern is anchored to this repo's absolute path and to the desktop session, so
# `pnpm dev:web`, `pnpm verify`, tests and `pnpm e2e`'s main here, a dev server in another
# checkout, or an installed IdleBiz, survive. Main itself is matched by nothing: it goes with the
# shell or dev server that started it, and stops its runs first, on its stdin closing or on TERM.
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
SELF=$$
DEV_PORT=31100

# outermost to innermost; pgrep -f matches the whole command line as an extended regex.
PATTERNS=(
  "$ROOT/apps/desktop/node_modules/.*@tauri-apps/cli/tauri\.js dev"  # tauri dev
  "$ROOT/apps/desktop/src-tauri/target/debug/idlebiz-desktop( |$)"    # the dev shell, if tauri dev is gone
)

descendants() {
  local child
  for child in $(pgrep -P "$1" 2>/dev/null || true); do
    echo "$child"
    descendants "$child"
  done
}

# each match with everything under it: the dev server, the shell and main
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

# TERM first so the shell and main can finish the write they are in the middle of (the save is
# markdown packages and an append-only log) and main can stop its runs, which takes it up to seven
# seconds (the scheduler's two, then each agent's five to leave before its group is killed); KILL
# whatever is still there after ten.
targets=()
for pid in $(session); do
  targets+=("$pid")
done
# the dev server's port's holder too, with what it started (`dev:browser`'s main), but only if it
# is this checkout's: another checkout's dev server is not ours to kill
for pid in $(lsof -ti "tcp:$DEV_PORT" -sTCP:LISTEN 2>/dev/null || true); do
  if ps -o args= -p "$pid" 2>/dev/null | grep -qF -- "$ROOT"; then
    targets+=("$pid")
    for child in $(descendants "$pid"); do
      targets+=("$child")
    done
  else
    echo "devkill: port $DEV_PORT is held by pid $pid, not from this checkout — leaving it" >&2
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
while any_alive && [ $n -lt 50 ]; do
  sleep 0.2
  n=$((n + 1))
done
for pid in "${targets[@]:-}"; do
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null && kill -9 "$pid" 2>/dev/null
done

n=0
while lsof -ti "tcp:$DEV_PORT" -sTCP:LISTEN >/dev/null 2>&1 && [ $n -lt 30 ]; do
  sleep 0.2
  n=$((n + 1))
done

port=free
lsof -ti "tcp:$DEV_PORT" -sTCP:LISTEN >/dev/null 2>&1 && port=BUSY
left=$(session | wc -l | tr -d ' ')
echo "devkill: killed $killed; port $DEV_PORT $port; session left: ${left:-0}"
[ "$port" = free ] && [ "${left:-0}" -eq 0 ]
