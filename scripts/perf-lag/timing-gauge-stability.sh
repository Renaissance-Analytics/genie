#!/usr/bin/env bash
# THE TIMING GAUGES UNDER LOAD (2026-11-01). Run in a test VM, from the shipped tree, after `npm ci`:
#
#   bash scripts/perf-lag/timing-gauge-stability.sh
#
# The four files that failed full-suite runs on omarchy-test, run 5 times each WHILE the full suite runs beside
# them (the load they failed under: every CPU busy). Exit 0 only when all 20 runs passed. The full suite's own result is
# reported separately, below: it runs alongside a second vitest, so a failure there is read on its own merits, and the
# batch's ordinary `npm test` stays the gate for the suite.
set -u
FILES="test/spawn-host-responsive.test.ts test/agent-stream-perf.test.ts test/renderer-per-event-cost.test.ts test/spawn-tracking-async.test.ts"
npx vitest run > "/tmp/stability-$$.suite.log" 2>&1 &
suite=$!
sleep 20
pass=0
fail=0
for n in 1 2 3 4 5; do
    for f in $FILES; do
        if npx vitest run "$f" > "/tmp/stability-$$.one.log" 2>&1; then
            pass=$((pass + 1)); r=pass
        else
            fail=$((fail + 1)); r=FAIL
        fi
        load=$(cut -d' ' -f1 /proc/loadavg 2>/dev/null || echo '?')
        echo "run $n $f: $r (load $load, suite $(kill -0 $suite 2>/dev/null && echo running || echo done))"
        grep -E "GAUGE:|PERF:|AssertionError|timed out" "/tmp/stability-$$.one.log" | sed 's/\x1b\[[0-9;]*m//g' | head -6 | sed 's/^/    /'
    done
done
wait $suite
suiteStatus=$?
echo "=== the loop: $pass passed, $fail failed (of 20)"
echo "=== the full suite beside it (exit $suiteStatus):"
sed 's/\x1b\[[0-9;]*m//g' "/tmp/stability-$$.suite.log" | grep -E "FAIL |Test Files|Tests " | head -20
rm -f "/tmp/stability-$$.one.log" "/tmp/stability-$$.suite.log"
[ "$fail" -eq 0 ]
