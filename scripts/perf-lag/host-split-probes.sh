#!/usr/bin/env bash
# THE HOST SPLIT'S BREAK-PROBES (genie#1386 phase 1). Run in a test VM, from the shipped tree, after `npm ci`:
#
#   bash scripts/perf-lag/host-split-probes.sh
#
# Each probe REMOVES one fix, runs the test written for it (which must FAIL), and puts the fix back (the tests must then
# pass). A test that stays green with its fix removed proves nothing. The probe edits go through a copy of each file, so
# the tree is restored on every path, including a failure in the middle. Exit 0 only when every probe went red and every
# restore went green.
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

probe "flush-before-answer" src/main/session-engine-server.ts \
    "        // RULE 1: the command's effect, then its answer.
        this.#flush();
" "" test/session-engine.test.ts "an awaited prompt is in the replica"

probe "window-trusts-host" src/main/session-engine-client.ts \
    "(transport as ClientTransport & { trusted?: () => void }).trusted?.();" "/* probe: not trusted */" \
    test/session-engine.test.ts "a frame larger than the pre-auth line limit"

probe "no-fallback-beside-live-host" src/main/agent-engine.ts \
    "        const live = liveHostPid();" "        const live: number | null = null; // probe" \
    test/agent-engine.test.ts "a LIVE host that will not link"

probe "host-has-no-electron" src/main/session-engine-server.ts \
    "import { randomUUID, timingSafeEqual } from 'node:crypto';" "import 'electron';
import { randomUUID, timingSafeEqual } from 'node:crypto';" \
    test/genie-host-no-electron.test.ts "imports electron nowhere"

echo "=== restored: every probed test file (green expected)"
if npx vitest run test/session-engine.test.ts test/agent-engine.test.ts test/genie-host-no-electron.test.ts > "/tmp/probe-$$.log" 2>&1; then
    grep -E "Test Files|Tests " "/tmp/probe-$$.log"
else
    echo "RESTORE FAILED"; grep -E "×|FAIL|Tests " "/tmp/probe-$$.log" | head -10; fail=1
fi
rm -f "/tmp/probe-$$.orig" "/tmp/probe-$$.log"
exit $fail
