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

# P2.2: the file watcher and git behind per-view subscriptions
probe "hub-refcount" src/main/files-watch-hub.ts \
    "        if ([...this.#views.values()].some((v) => v.workspaceId === workspaceId)) return;" "        if (false) return;" \
    test/files-watch-hub.test.ts "CLOSED when the last view leaves"

probe "hub-git-once" src/main/files-watch-hub.ts \
    "        if (w.gitRunning) { w.gitDirty = true; return; }" "" \
    test/files-watch-hub.test.ts "does not start a second run"

probe "engine-drops-closed-window-views" src/main/session-engine-server.ts \
    "            if (was) this.#options.files?.dropOwner(conn.id);" "" \
    test/engine-files-tunnel.test.ts "drops every view it had"

probe "client-resubscribes" src/main/session-engine-client.ts \
    "        for (const [viewId, v] of this.#filesViews) void this.call('engine.filesWatch', [viewId, v.workspace, v.want]);" "" \
    test/engine-files-tunnel.test.ts "subscribes its views again"

# main x host split: Cooling (#1433) reaches the window through the host replica
probe "cooling-end-pushed" src/core/session.ts \
    "            this.#coolingCancel = null;
            this.#changed();" "            this.#coolingCancel = null;" \
    test/engine-cooling-replica.test.ts "each step pushed to the window"

# P3.1: Genie's MCP server and the stores agents write to, in genie-host
probe "host-tool-refuses-without-window" src/main/mcp-host-tools.ts \
    "            if (!options.window.connected()) {" "            if (false) {" \
    test/mcp-host-tools.test.ts "with NO window: refused AT ONCE"

probe "replica-follows-mail" src/main/agent-stores-host.ts \
    "        this.#emit({ store: 'inbox', kind: 'delta', appended, updated, removed, cursors: { ...mail.cursors } });" "" \
    test/agent-stores-contract.test.ts "after an agent sends"

probe "dump-before-ready" src/main/session-engine-server.ts \
    "        if (this.#options.stores) this.#event(conn, 'stores.dump', this.#options.stores.dump());" "" \
    test/agent-stores-contract.test.ts "connects later starts from the whole mail"

# P3.2: the settings are the host's; every window a replica, hot-swap kept
probe "settings-data-before-listeners" src/main/agent-stores-replica.ts \
    "        this.#data = event.data;" "" \
    test/settings-drafts-contract.test.ts "ALREADY readable"

probe "settings-change-reaches-windows" src/main/agent-stores-host.ts \
    "        stores.settings?.onChange((key, value, workspaceId) => this.#emit({ store: 'settings', kind: 'changed', key, value, workspaceId: workspaceId ?? null, data: stores.settings!.data() }));" "" \
    test/settings-drafts-contract.test.ts "a change made ELSEWHERE"

probe "registry-write-reaches-windows" src/main/agent-stores-host.ts \
    "                    this.#emit({ store: 'registry', kind: 'written' });" "" \
    test/registry-host-contract.test.ts "two windows see one registry"

probe "host-mail-wake-starts" src/main/host-mail-wake.ts \
    "        wake," "" \
    test/host-mail-wake.test.ts "a STOPPED agent is started for its mail"

# P3.3b: the process supervisor is the host's
probe "window-stop-reaches-host" src/main/supervisor-host.ts \
    "        void this.#call('stop', [id]).catch(() => {});" "" \
    test/supervisor-host-contract.test.ts "Stop from a window ends it FOR GOOD"

probe "start-of-running-is-noop" src/main/process-supervisor.ts \
    "        if (existing && existing.state === 'running') return this.#status(existing);" "" \
    test/supervisor-host-contract.test.ts "starts nothing twice"

probe "supervisor-dump-before-ready" src/main/session-engine-server.ts \
    "        if (this.#options.supervisor) this.#event(conn, 'supervisor.dump', this.#options.supervisor.dump());" "" \
    test/supervisor-host-contract.test.ts "the next window shows it"

# P3.3c: the process book and the scheduler are the host's
probe "book-dump-before-ready" src/main/session-engine-server.ts \
    "        if (this.#options.processes) this.#event(conn, 'processes.event', this.#options.processes.dump());" "" \
    test/process-book-host-contract.test.ts "the next window lists its run"

# P3.3d: flows are the host's
probe "flows-dump-before-ready" src/main/session-engine-server.ts \
    "        if (this.#options.flows) this.#event(conn, 'flows.event', { kind: 'dump', dump: this.#options.flows.dump() });" "" \
    test/flows-host-contract.test.ts "the next window sees its run"

# P3.3e: the terminals are the host's
probe "terminals-dump-before-ready" src/main/session-engine-server.ts \
    "        if (this.#options.terminals) this.#event(conn, 'terminals.dump', this.#options.terminals.dump());" "" \
    test/terminals-host-contract.test.ts "OUTLIVES its window"

echo "=== restored: every probed test file (green expected)"
if npx vitest run test/session-engine.test.ts test/agent-engine.test.ts test/genie-host-no-electron.test.ts test/spawn-relay.test.ts test/process-supervisor-adopt.test.ts test/spawn-host-link.test.ts test/terminal-open-ready.test.ts test/files-watch-hub.test.ts test/engine-files-tunnel.test.ts test/engine-cooling-replica.test.ts test/mcp-host-tools.test.ts test/agent-stores-contract.test.ts test/settings-drafts-contract.test.ts test/registry-host-contract.test.ts test/host-mail-wake.test.ts test/supervisor-host-contract.test.ts test/process-book-host-contract.test.ts test/flows-host-contract.test.ts test/terminals-host-contract.test.ts > "/tmp/probe-$$.log" 2>&1; then
    grep -E "Test Files|Tests " "/tmp/probe-$$.log"
else
    echo "RESTORE FAILED"; grep -E "×|FAIL|Tests " "/tmp/probe-$$.log" | head -10; fail=1
fi
rm -f "/tmp/probe-$$.orig" "/tmp/probe-$$.log"
exit $fail
