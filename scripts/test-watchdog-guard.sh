#!/bin/bash
# Regression test for the watchdog guard in Start-SocialScheduler-Mac.command.
#
#   bash scripts/test-watchdog-guard.sh      # ~10 seconds, touches nothing real
#
# THE BUG THIS PINS (hit for real 2026-08-05): the watchdog's cleanup used to run
# unconditionally after its sleep. `sleep` is naive about wall clock and macOS suspends
# it while the Mac sleeps, so a watchdog wakes long after its recorded deadline — by
# which time the owner may have restarted everything. It then deleted the CURRENT
# worker's pid files, leaving a worker publishing for real that Stop could no longer
# find (Stop reports success and kills nothing), and signalled a stale PID number that
# may since have been recycled onto an unrelated process.
#
# ⚠ The guard block in start_watchdog() below is a VERBATIM COPY of the one in
# Start-SocialScheduler-Mac.command (only AUTO_SECS differs, 2s vs 12h). There is no
# way to source it out of that script, so IF YOU CHANGE ONE, CHANGE BOTH.
#
# NOTE: fake workers are started in the MAIN shell, not via $(command substitution) —
# a background child of a substitution subshell dies when that subshell exits, which
# silently made an earlier version of this test pass without proving anything. The
# HARNESS SANITY check at the top exists to catch exactly that class of false pass.
set -u
RUN_DIR="$(mktemp -d)"
BIN_DIR="$(mktemp -d)"
# A stand-in worker whose ps command line contains "worker.run". It must be a SCRIPT,
# not a copy of /bin/sleep: macOS SIGKILLs copied system binaries (broken code signature).
# It must also not `exec`, or the command line would become plain "sleep" and lose the name.
# The inner sleep is SHORT and the process is launched with its output detached: killing
# the bash parent orphans the sleep child, and an orphan holding the caller's stdout hangs
# any pipe the test is run through (`... | grep`) until it exits. Short + detached means
# an orphan can neither hang a pipe nor litter for long.
printf '#!/bin/bash\nsleep 30\n' > "$BIN_DIR/worker.run"
chmod +x "$BIN_DIR/worker.run"
AUTO_SECS=2
FAILED=0

start_watchdog() {  # $1 = WORKER_PID, $2 = optional absolute deadline epoch
  local WORKER_PID="$1"
  local DEADLINE_EPOCH="${2:-$(( $(date +%s) + AUTO_SECS ))}"
  local WATCH_POLL=1
  (
    while [ "$(date +%s)" -lt "$DEADLINE_EPOCH" ]; do sleep "$WATCH_POLL"; done
    still_ours="$(cat "$RUN_DIR/worker.pid" 2>/dev/null | tr -d '[:space:]')"
    if [ "$still_ours" = "$WORKER_PID" ]; then
      if ps -p "$WORKER_PID" -o command= 2>/dev/null | grep -q "worker\.run"; then
        kill "$WORKER_PID" 2>/dev/null
      fi
      rm -f "$RUN_DIR/worker.pid" "$RUN_DIR/watchdog.pid" "$RUN_DIR/worker.deadline"
    fi
  ) >/dev/null 2>&1 &
}

check() { if [ "$2" = "$3" ]; then echo "  ok: $1"; else echo "  FAIL: $1 (expected '$2', got '$3')"; FAILED=1; fi; }
alive() { kill -0 "$1" 2>/dev/null && echo alive || echo dead; }

# --- sanity: the harness's own fake worker must actually stay up -------------------
"$BIN_DIR/worker.run" >/dev/null 2>&1 & SANITY=$!; disown
sleep 3
check "HARNESS SANITY: a fake worker survives 3s" "alive" "$(alive $SANITY)"
kill "$SANITY" 2>/dev/null

echo
echo "TEST 1 — watchdog fires while it is still the current owner"
"$BIN_DIR/worker.run" >/dev/null 2>&1 & W1=$!; disown
echo "$W1" > "$RUN_DIR/worker.pid"
echo "wd" > "$RUN_DIR/watchdog.pid"; echo "deadline" > "$RUN_DIR/worker.deadline"
check "  (precondition) worker is up"    "alive" "$(alive $W1)"
start_watchdog "$W1"
sleep 4
check "its own worker was killed"        "dead"  "$(alive $W1)"
check "worker.pid removed"               "gone"  "$([ -f "$RUN_DIR/worker.pid" ] && echo present || echo gone)"
check "watchdog.pid removed"             "gone"  "$([ -f "$RUN_DIR/watchdog.pid" ] && echo present || echo gone)"
check "worker.deadline removed"          "gone"  "$([ -f "$RUN_DIR/worker.deadline" ] && echo present || echo gone)"

echo
echo "TEST 2 — a LATE watchdog whose worker was replaced (the bug being fixed)"
"$BIN_DIR/worker.run" >/dev/null 2>&1 & OLD=$!; disown
echo "$OLD" > "$RUN_DIR/worker.pid"
start_watchdog "$OLD"                     # this watchdog is now obsolete...
kill "$OLD" 2>/dev/null                   # ...old worker stopped
"$BIN_DIR/worker.run" >/dev/null 2>&1 & NEW=$!; disown        # ...and a NEW worker took over
[ "$OLD" = "$NEW" ] && echo "  (skip: PID reuse made OLD==NEW)" || true
echo "$NEW" > "$RUN_DIR/worker.pid"
echo "new-wd" > "$RUN_DIR/watchdog.pid"; echo "new-deadline" > "$RUN_DIR/worker.deadline"
check "  (precondition) new worker is up" "alive" "$(alive $NEW)"
sleep 4
check "NEW worker left running"           "alive" "$(alive $NEW)"
check "NEW worker.pid preserved"          "$NEW"  "$(cat "$RUN_DIR/worker.pid" 2>/dev/null)"
check "NEW watchdog.pid preserved"        "new-wd" "$(cat "$RUN_DIR/watchdog.pid" 2>/dev/null)"
check "NEW worker.deadline preserved"     "new-deadline" "$(cat "$RUN_DIR/worker.deadline" 2>/dev/null)"
kill "$NEW" 2>/dev/null

echo
echo "TEST 3 — deadline already in the past (what waking from system sleep looks like)"
# The old code slept a fixed countdown, so a Mac that slept through the deadline left the
# worker running for hours past the advertised time. Polling an ABSOLUTE epoch means a
# watchdog that wakes late fires at once instead of restarting its countdown.
"$BIN_DIR/worker.run" >/dev/null 2>&1 & LATE=$!; disown
echo "$LATE" > "$RUN_DIR/worker.pid"
echo "wd" > "$RUN_DIR/watchdog.pid"; echo "deadline" > "$RUN_DIR/worker.deadline"
check "  (precondition) worker is up"     "alive" "$(alive $LATE)"
start_watchdog "$LATE" "$(( $(date +%s) - 3600 ))"   # deadline passed an hour ago
sleep 3
check "late watchdog stopped it promptly" "dead"  "$(alive $LATE)"
check "worker.pid removed"                "gone"  "$([ -f "$RUN_DIR/worker.pid" ] && echo present || echo gone)"

rm -rf "$RUN_DIR" "$BIN_DIR"
echo
[ "$FAILED" = 0 ] && echo "ALL WATCHDOG GUARD CHECKS PASSED" || { echo "SOME CHECKS FAILED"; exit 1; }
