#!/usr/bin/env bash
# Keeps `wa daemon` running: restarts on crash with backoff, stops on exit 2 (logged out) or 3 (already running).
# Usage: wa-supervise.sh            run in foreground loop
#        wa-supervise.sh --ensure   start detached supervisor if none is running (idempotent; use after reboot / from a periodic check)
set -u
DIR="$(cd "$(dirname "$0")" && pwd)"; HOME_DIR="${WA_BRIDGE_DIR:-$HOME/.wa-bridge}"; mkdir -p "$HOME_DIR"
LOCK="$HOME_DIR/supervisor.pid"; LOG="$HOME_DIR/daemon.log"
alive() { [ -f "$1" ] && kill -0 "$(cat "$1")" 2>/dev/null; }
if [ "${1:-}" = "--ensure" ]; then
  if alive "$LOCK"; then echo "supervisor running (pid $(cat "$LOCK"))"; exit 0; fi
  nohup setsid "$0" >>"$LOG" 2>&1 < /dev/null & sleep 1; echo "supervisor started (pid $(cat "$LOCK" 2>/dev/null))"; exit 0
fi
if alive "$LOCK" && [ "$(cat "$LOCK")" != "$$" ]; then echo "supervisor already running"; exit 0; fi
echo $$ > "$LOCK"; trap 'kill $child 2>/dev/null; rm -f "$LOCK"; exit 0' TERM INT
delay=2
while true; do
  start=$(date +%s); echo "[$(date -Is)] supervisor: starting daemon"
  node "$DIR/wa.mjs" daemon & child=$!; wait $child; rc=$?
  echo "[$(date -Is)] supervisor: daemon exited rc=$rc"
  case $rc in 2|3) rm -f "$LOCK"; exit $rc ;; esac
  [ $(( $(date +%s) - start )) -gt 300 ] && delay=2
  sleep $delay; delay=$(( delay*2 > 60 ? 60 : delay*2 ))
done
