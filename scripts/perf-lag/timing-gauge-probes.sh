#!/usr/bin/env bash
# THE TIMING GAUGES' BREAK-PROBES (2026-11-01). Run in a test VM, from the shipped tree, after `npm ci`:
#
#   bash scripts/perf-lag/timing-gauge-probes.sh
#
# Three tests failed most full-suite runs on omarchy-test on timing alone (test/spawn-host-responsive.test.ts,
# test/agent-stream-perf.test.ts, test/renderer-per-event-cost.test.ts). They now count what they name, or hold a bar a
# fifth of the failure. Each probe below PUTS BACK the bug a test names, runs that test (which must FAIL, on the named
# test), and restores the tree (the tests must then pass). A test that stays green with its bug back proves nothing.
# Every edit goes through a copy of the file, so the tree is restored on every path. Exit 0 only when every probe went
# red and the restore went green.
set -u
fail=0
probe() {
    local name="$1" file="$2" anchor="$3" replacement="$4" tests="$5" expect="$6"
    cp "$file" "/tmp/probe-$$.orig"
    node -e "const fs=require('fs');const p=process.argv[1];let s=fs.readFileSync(p,'utf8').split('\r\n').join('\n');if(!s.includes(process.argv[2])){console.error('anchor missing');process.exit(2)}fs.writeFileSync(p,s.replace(process.argv[2],process.argv[3]))" "$file" "$anchor" "$replacement" || { echo "PROBE $name: anchor missing in $file"; fail=1; cp "/tmp/probe-$$.orig" "$file"; return; }
    judge "$name" "$tests" "$expect"
    cp "/tmp/probe-$$.orig" "$file"
}
judge() {
    local name="$1" tests="$2" expect="$3"
    if npx vitest run $tests > "/tmp/probe-$$.log" 2>&1; then
        echo "PROBE $name: STAYED GREEN with the bug put back (the test is vacuous)"; fail=1
    elif grep -q "$expect" "/tmp/probe-$$.log"; then
        echo "PROBE $name: red as expected ($expect)"
        grep -E "GAUGE:|PERF:|AssertionError" "/tmp/probe-$$.log" | sed 's/\x1b\[[0-9;]*m//g' | head -4 | sed 's/^/    /'
    else
        echo "PROBE $name: red, but not on the expected test ($expect)"; grep -E "×|FAIL" "/tmp/probe-$$.log" | head -5; fail=1
    fi
}

# 1. A SYNCHRONOUS SPAWN ON MAIN: the tree without the spawn host (the test's own fallback: in-process, the 5 s spawn on
#    main's thread). Both host tests must read about 5,000 ms and fail the 1 s bar; the CONTROL stays green.
mv src/main/spawn-host-client.ts "/tmp/probe-$$.shc"
trap 'mv "/tmp/probe-$$.shc" src/main/spawn-host-client.ts 2>/dev/null' EXIT
judge "spawn-on-main (docker exec)" test/spawn-host-responsive.test.ts "> Docker state read through the runner"
if grep -q "> a supervised process (a site's php-cgi)" "/tmp/probe-$$.log"; then echo "PROBE spawn-on-main (pty): red as expected"; else echo "PROBE spawn-on-main (pty): NOT red"; fail=1; fi
if grep -q "FAIL .*CONTROL" "/tmp/probe-$$.log"; then echo "PROBE spawn-on-main: the CONTROL failed too (it must read the 5 s either way)"; fail=1; fi
mv "/tmp/probe-$$.shc" src/main/spawn-host-client.ts
trap - EXIT

# 2. THE LEDGER REBUILT PER READ: main's `ledgerFor` copies every row again on every call (what each event did before).
probe "ledger-rebuilt-per-read" src/main/session-host.ts \
    "        if (entry.ledger !== null && entry.ledger.history === loaded) return entry.ledger.rows;
" "" test/agent-stream-perf.test.ts "old rows read per event"

# 3. THE ROWS RESCANNED PER PROBE: the background count reads the whole ledger on every probe, not only when it changed.
probe "rows-rescanned-per-probe" src/core/background-count.ts \
    "        if (this.#stale) {" "        if (this.#stale || this.#scans >= 0) { // probe: every probe" \
    test/agent-stream-perf.test.ts "old rows read per event"

# 4. A FULL LEDGER COPY INTO THE PAGE: the preload rebuilds the whole ledger from each patch and hands THAT to the page
#    (the beta.36 freeze: every push copied the ledger across contextBridge).
probe "ledger-copied-into-page" src/main/preload.ts \
    "                for (const subscriber of subscribers) subscriber(payload);" \
    "                { const r = payload.rows; const s = subscribers as unknown as { held?: unknown[] }; s.held = r.base === null ? [...r.append] : [...(s.held ?? []).slice(0, r.keep), ...r.append]; const whole = { ...payload, rows: { base: null, keep: 0, append: s.held } } as unknown as AgentPayload; for (const subscriber of subscribers) subscriber(whole); } // probe" \
    test/renderer-per-event-cost.test.ts "rows into the page per event"

echo "=== restored: every probed test file (green expected)"
if npx vitest run test/spawn-host-responsive.test.ts test/agent-stream-perf.test.ts test/renderer-per-event-cost.test.ts > "/tmp/probe-$$.log" 2>&1; then
    grep -E "GAUGE:|PERF:|Test Files|Tests " "/tmp/probe-$$.log" | sed 's/\x1b\[[0-9;]*m//g'
else
    echo "RESTORE FAILED"; grep -E "×|FAIL|Tests " "/tmp/probe-$$.log" | head -10; fail=1
fi
if git rev-parse --git-dir > /dev/null 2>&1; then git diff --quiet -- src/ || { echo "TREE NOT RESTORED"; git status --short -- src/; fail=1; }; fi
rm -f "/tmp/probe-$$.orig" "/tmp/probe-$$.log"
exit $fail
