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

# P2.1: processes and terminals under genie-host
probe "relay-waits-for-gone" src/main/spawn-relay.ts \
    "        while (pending.size > 0 && Date.now() < deadline) {" "        while (false) {" \
    test/spawn-relay.test.ts "reported exited (-1) once GONE"

probe "supervisor-claims-not-spawns" src/main/process-supervisor.ts \
    "        if (adopted) this.#claim(entry, adopted);" "        if (false) this.#claim(entry, adopted);" \
    test/process-supervisor-adopt.test.ts "CLAIMS its pty"

probe "link-reconcile-reports-vanished" src/main/spawn-host-client.ts \
    "            if (live.has(id)) continue;" "            continue;" \
    test/spawn-host-link.test.ts "a pty it knew that is gone is reported exited"

probe "terminal-open-waits-for-pid" src/main/terminal-host.ts \
    "            if (opened.pid > 0 || !this.#pty.onPid) return opened;" "            return opened;" \
    test/terminal-open-ready.test.ts "answers once the pid is known"

probe "spawn-host-says-the-shell" src/main/spawn-host-server.ts \
    "event('pty.opened', { id: ptyId, pid: opened.pid, shell: opened.shell });" "event('pty.opened', { id: ptyId, pid: opened.pid });" \
    test/terminal-open-ready.test.ts "pty.opened carries the resolved shell"

probe "relay-logs-ready" src/main/spawn-relay.ts \
    "                    log(\`spawn host ready pid=" "                    void (\`spawn host ready pid=" \
    test/spawn-relay.test.ts "named in the lifecycle log"

echo "=== restored: every probed test file (green expected)"
if npx vitest run test/session-engine.test.ts test/agent-engine.test.ts test/genie-host-no-electron.test.ts test/spawn-relay.test.ts test/process-supervisor-adopt.test.ts test/spawn-host-link.test.ts test/terminal-open-ready.test.ts > "/tmp/probe-$$.log" 2>&1; then
    grep -E "Test Files|Tests " "/tmp/probe-$$.log"
else
    echo "RESTORE FAILED"; grep -E "×|FAIL|Tests " "/tmp/probe-$$.log" | head -10; fail=1
fi
rm -f "/tmp/probe-$$.orig" "/tmp/probe-$$.log"
exit $fail
