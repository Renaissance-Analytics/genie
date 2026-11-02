#!/usr/bin/env bash
# BREAK-PROBES FOR genie#1452 (bugs A and B from batch L4, confirmed by VM job 76). Run in a test VM, from the shipped tree,
# after `npm ci` (Linux: the tests read /proc):
#
#   bash scripts/perf-lag/pty-fds-probes.sh
#
# Each probe REMOVES one fix, runs the test written for it (which must FAIL), and puts the fix back (the tests must then
# pass). Kept apart from host-split-probes.sh so #1452 and P1b (#1451) can be batched together without a conflict; fold it
# in once both are merged. Exit 0 only when every probe went red and the restore went green.
set -u
fail=0
probe() {
    local name="$1" file="$2" anchor="$3" replacement="$4" tests="$5" expect="$6"
    cp "$file" "/tmp/probe-$$.orig"
    node -e "const fs=require('fs');const p=process.argv[1];let s=fs.readFileSync(p,'utf8').split('\r\n').join('\n');if(!s.includes(process.argv[2])){console.error('anchor missing');process.exit(2)}fs.writeFileSync(p,s.replace(process.argv[2],process.argv[3]))" "$file" "$anchor" "$replacement" || { echo "PROBE $name: anchor missing in $file"; fail=1; cp "/tmp/probe-$$.orig" "$file"; return; }
    if npx vitest run $tests > "/tmp/probe-$$.log" 2>&1; then
        echo "PROBE $name: STAYED GREEN with the fix removed (the test is vacuous)"; fail=1
    elif grep -q "$expect" "/tmp/probe-$$.log"; then
        echo "PROBE $name: red as expected ($expect)"
    else
        echo "PROBE $name: red, but not on the expected test ($expect)"; grep -E "×|FAIL" "/tmp/probe-$$.log" | head -5; fail=1
    fi
    cp "/tmp/probe-$$.orig" "$file"
}

# A: the host closes what it inherited before anything of it runs
probe "host-closes-inherited-fds" src/main/genie-host.ts \
    "import './close-inherited-fds.js';" "" \
    test/host-pty-fds.test.ts "NOTHING holds the inherited socket"

probe "only-sockets-and-pipes-are-closed" src/main/inherited-fds.ts \
    "        return info.target.startsWith('socket:') || info.target.startsWith('pipe:');" "        return true;" \
    test/inherited-fds.test.ts "picks sockets and pipes"

# B: the next host reaps what a dead owner left, and only what is still the same process
probe "next-host-reaps-leftover-ptys" src/main/genie-host.ts \
    "    if (leftover) reapLeftoverPtys(leftover, realReapPorts((line) => { say(line); lifecycleLog(line); }));" "" \
    test/host-pty-fds.test.ts "the NEXT host reaps"

probe "reap-only-the-same-process" src/main/pty-ledger.ts \
    "        if (pty.start === null || now === null || now !== pty.start) {" "        if (false) {" \
    test/pty-ledger.test.ts "reused by another process"

probe "relay-says-its-ptys" src/main/spawn-relay.ts \
    "            slot.ptys.clear();
            ptysChanged();" "            slot.ptys.clear();" \
    test/pty-ledger.test.ts "a child that dies takes its ptys out"

echo "=== restored: every probed test file (green expected)"
if npx vitest run test/host-pty-fds.test.ts test/inherited-fds.test.ts test/pty-ledger.test.ts test/spawn-relay.test.ts > "/tmp/probe-$$.log" 2>&1; then
    grep -E "Test Files|Tests " "/tmp/probe-$$.log"
else
    echo "RESTORE FAILED"; grep -E "×|FAIL|Tests " "/tmp/probe-$$.log" | head -10; fail=1
fi
rm -f "/tmp/probe-$$.orig" "/tmp/probe-$$.log"
exit $fail
