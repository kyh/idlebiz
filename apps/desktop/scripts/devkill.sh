#!/usr/bin/env bash
# Kill the electron-vite dev server + all Electron instances for this project
# and free the CDP debug port (9222). Idempotent.
pkill -9 -f "node_modules/.bin/electron-vite" 2>/dev/null
pkill -9 -f "office/node_modules/electron/dist" 2>/dev/null
for pid in $(lsof -ti tcp:9222 2>/dev/null); do kill -9 "$pid" 2>/dev/null; done
n=0
while lsof -ti tcp:9222 >/dev/null 2>&1 && [ $n -lt 30 ]; do sleep 0.2; n=$((n+1)); done
echo "devkill: port 9222 $(lsof -ti tcp:9222 2>/dev/null && echo BUSY || echo free); electron $(pgrep -f 'office/node_modules/electron' 2>/dev/null && echo RUNNING || echo none)"
