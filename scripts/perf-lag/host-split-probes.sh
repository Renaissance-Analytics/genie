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
    if ! (for f in $tests; do grep -qF -- "$expect" "$f" 2>/dev/null && exit 0; done; exit 1); then
        echo "PROBE $name: NO SUCH TEST: no test file in ($tests) holds ($expect), so this probe would prove nothing"; fail=1
        return
    fi
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

# P1b: the quit keeps the host, and the tray keeps Genie (the owner, 2026-11-02: "Keep the tray up")
probe "close-ui-is-not-a-quit" src/core/quit.ts \
    "                if (answer === 'close-ui') return 'close-ui';" "" \
    test/quit-sequence.test.ts "JUST CLOSE THE UI is not a quit"

probe "shut-down-ends-the-host" src/core/quit.ts \
    "    await ports.shutDownHost();" "" \
    test/quit-sequence.test.ts "calls stopAll and then engine.shutdown"

probe "quit-asks-two-answers" src/core/quit.ts \
    "    if (input.host) return hostPlan(input.runningAgents, input.liveTerminals, input.host.keptProcesses);" "" \
    test/quit-plan.test.ts "the two answers, Cancel by default"

probe "tray-only-exits-after-the-grace" src/core/tray-only.ts \
    "    return { quietSince: since, exit: now - since >= graceMs };" "    return { quietSince: since, exit: false };" \
    test/tray-only.test.ts "at the grace it exits"

probe "tray-offers-the-host-verbs" src/main/tray.ts \
    "        ...(handlers.onCloseUi && handlers.onRestart && handlers.onShutDown" "        ...(false && handlers.onCloseUi && handlers.onRestart && handlers.onShutDown" \
    test/tray.test.ts "Just close the UI, Restart, Shut down everything"

probe "tray-only-has-no-close-ui" src/main/tray.ts \
    "                ...(handlers.uiOpen?.() !== false ? [{ label: 'Just close the UI', click: handlers.onCloseUi }] : [])," "                { label: 'Just close the UI', click: handlers.onCloseUi }," \
    test/tray.test.ts "tray-only (no window)"

probe "tray-says-what-runs" src/main/tray.ts \
    "    const hostPart = words === null ? [] : [words ? \`host running: \${words}\` : 'host running'];" "    const hostPart: string[] = [];" \
    test/tray.test.ts "WHAT it runs"

probe "tray-probe-is-gated" src/main/main.ts \
    "    if (trayProbeEnabled(process.env)) {" "    if (true) {" \
    test/quit-keeps-host-wiring.test.ts "ABSENT without GENIE_TRAY_PROBE=1"

# ALWAYS ASK (the owner, 2026-11-02): the tray's Restart and Shut down everything confirm first
probe "tray-always-asks" src/main/main.ts \
    "onShutDown: () => { if (confirmTray('shut-down')) requestQuit('shut-down'); }" "onShutDown: () => { requestQuit('shut-down'); }" \
    test/quit-keeps-host-wiring.test.ts "offers the host"

probe "only-the-confirm-button-goes-on" src/core/tray-confirm.ts \
    "    return button === 1;" "    return button !== 0;" \
    test/tray-confirm.test.ts "only the confirm button goes on"

# §13: plaintext files that hold secrets are the owner's alone
probe "private-files-are-0600" src/main/store.ts \
    "    const handle = await open(tmp, 'w', mode);" "    const handle = await open(tmp, 'w');" \
    test/runtime-file-modes.test.ts "a fresh write is 0600"

probe "open-files-are-tightened" src/main/store.ts \
    "    await chmod(file, PRIVATE_FILE.mode).catch(" "    await Promise.resolve().catch(" \
    test/runtime-file-modes.test.ts "tightened at open"

# Decision 2: scrollback is not saved; an upgrade deletes what an older Genie left
probe "upgrade-deletes-saved-scrollback" src/main/saved-scrollback.ts \
    "            await rm(path, { recursive: true, force: true });" "" \
    test/no-saved-scrollback.test.ts "are GONE"

# P3.4 cut a: the keychain. The pin is the core: unpinned, a secret is silently lost at the next reboot.
probe "keychain-every-entry-is-pinned" src/main/keychain.ts \
    "        return new AsyncEntry(KEYCHAIN_SERVICE, name, ENTRY_OPTIONS);" "        return new AsyncEntry(KEYCHAIN_SERVICE, name);" \
    test/keychain.test.ts "each build their entry with the pin"

probe "keychain-pin-is-secret-service" src/main/keychain.ts \
    "export const ENTRY_OPTIONS = { linux: { store: 'secret-service' } } as const;" "export const ENTRY_OPTIONS = { linux: { store: 'keyutils' } } as const;" \
    test/keychain.test.ts "cannot fall back to the kernel keyring"

probe "keychain-unavailable-is-not-missing" src/main/keychain.ts \
    "            return { kind: 'unavailable', reason: said(error) };" "            return { kind: 'missing' };" \
    test/keychain.test.ts "never as missing"

probe "host-ready-only-when-the-keychain-answers" src/main/host-keychain.ts \
    "        storage: () => ({ backend: 'gnome_libsecret', available: answers })," "        storage: () => ({ backend: 'gnome_libsecret', available: true })," \
    test/keychain.test.ts "whose keychain still refuses"

# P3.4 cut b: the migration. Each of these, broken, loses a sign-in or moves one twice.
probe "migration-read-back-gates-the-delete" src/main/keychain-migration.ts \
    "    if (back !== 'same') return 'read-back-differs';" "" \
    test/keychain-migration.test.ts "kept, not confirmed, and said"

probe "migration-book-before-the-delete" src/main/keychain-migration.ts \
    "    if (!(await book.write(name, 'verified').then(() => true, () => false))) return 'book-failed';" "" \
    test/keychain-migration.test.ts "each crash really stopped the run where it says"

probe "migration-never-runs-twice" src/main/keychain-migration.ts \
    "    if (state === 'done') return 'already';" "" \
    test/keychain-migration.test.ts "the old copy is not even read"

probe "migration-confirmed-is-not-written-back" src/main/keychain-migration.ts \
    "    if (state === 'verified') {" "    if ((state as string) === 'never') {" \
    test/keychain-migration.test.ts "does NOT write it back"

probe "migration-confirmed-needs-an-entry" src/main/keychain-migration.ts \
    "        if (now === 'missing') return 'confirmed-entry-missing';" "" \
    test/keychain-migration.test.ts "the old copy is NOT deleted"

probe "migration-unreadable-book-touches-nothing" src/main/keychain-migration.ts \
    "            return sources.map(({ name }) => ({ name, status: 'book-failed' as const }));" "            states = {};" \
    test/keychain-migration.test.ts "because it might say this already ran"

probe "migration-host-compares-for-real" src/main/keychain-migration.ts \
    "            return read.value === value ? 'same' : 'different';" "            return 'same';" \
    test/keychain-migration.test.ts "compare answers same, different"


# P3.4 cut d: an agent's key is the host's (genie#1457).
probe "a-window-asks-only-for-agent-keys" src/main/session-engine-server.ts \
    "                return this.#keychain().get(agentKeyName(str(0)));" "                return this.#keychain().get(str(0) as never);" \
    test/host-agent-keys.test.ts "nothing but an agent"

probe "a-dead-link-is-not-a-missing-key" src/main/agent-secrets.ts \
    "            return reply.ok ? (reply.value as KeychainRead) : { kind: 'unavailable', reason: reply.reason };" "            return reply.ok ? (reply.value as KeychainRead) : { kind: 'missing' };" \
    test/host-agent-keys.test.ts "a dead link is not a signed-out agent"

probe "a-sealed-key-must-match-its-record" src/main/tynn-agent-identities.ts \
    "? { kind: 'value', value: token } : { kind: 'unreadable' };" "? { kind: 'value', value: token } : { kind: 'value', value: token };" \
    test/host-agent-keys.test.ts "is not moved, and not deleted"


# P3.4 cut c: the Tynn account is the host's, and its pairing is in the keychain.
probe "locked-keychain-keeps-whose-it-is" src/main/tynn-account.ts \
    "            this.#savedUser = data.userId;" "" \
    test/tynn-account-host.test.ts "whose it is stays known"

probe "no-keychain-refuses-before-the-exchange" src/main/tynn-account.ts \
    "        if (!(await this.#ports.secrets.probe()).ok) return { ok: false, reason: NO_KEYRING_FOR_TYNN };" "" \
    test/tynn-account-host.test.ts "so the code is not spent"

probe "sign-out-removes-the-entry" src/main/tynn-account.ts \
    "            if (!credential) await this.#ports.secrets.delete(PAIRING).catch(() => {});" "" \
    test/tynn-account-host.test.ts "a sign-out removes it"

probe "only-a-real-pairing-token-moves" src/main/tynn-account.ts \
    "                    return tokenValid(token) ? { kind: 'value', value: token } : { kind: 'unreadable' };" "                    return { kind: 'value', value: token };" \
    test/tynn-account-host.test.ts "is not a pairing token"

probe "a-window-reads-signed-in-at-once" src/main/session-engine-server.ts \
    "        if (this.#options.tynn) this.#event(conn, 'tynn.event', this.#options.tynn.dump());" "" \
    test/tynn-account-host.test.ts "reads signed in at once"

probe "the-cookie-is-sent-on-the-exchange" src/main/host-tynn-account.ts \
    "const cookies = init.credentials === 'include' ? jar.get(new URL(url).origin) : undefined;" "const cookies = undefined as Map<string, string> | undefined;" \
    test/tynn-account-host.test.ts "the code goes as a Cookie"


# P3.4 cut c: the host's HTTPS. Broken, each of these sends a token where it should not, or refuses Tynn.
probe "explicit-verification-beats-the-env-variable" src/main/host-https-fetch.ts \
    "        const ask = request(target, { method: init.method, headers: init.headers, agent, rejectUnauthorized: true, signal: init.signal }, (res) => {" "        const ask = request(target, { method: init.method, headers: init.headers, signal: init.signal, agent: new Agent({ ca: [...rootsOfThisMachine()] }) }, (res) => {" \
    test/host-https-fetch.test.ts "turns nothing off"

probe "the-trust-set-is-the-machines" src/main/host-https-fetch.ts \
    "ca: [...(options.machineRoots ?? rootsOfThisMachine)()]," "ca: [...rootsOfThisMachine()]," \
    test/host-https-fetch.test.ts "a CA in the OS store answers"

probe "a-redirect-is-refused" src/main/host-https-fetch.ts \
    "            if (status >= 300 && status < 400) {" "            if (status === 999) {" \
    test/host-https-fetch.test.ts "a redirect is REFUSED"

probe "only-https" src/main/host-https-fetch.ts \
    "        if (target.protocol !== 'https:') throw" "        if (target.protocol === 'never:') throw" \
    test/host-https-fetch.test.ts "it speaks only https"


# P3.4 cut c: the OS's proxy. Broken, each of these leaks a credential, or goes around a proxy with nothing said.
probe "a-proxy-credential-is-dropped" src/core/proxy-answer.ts \
    "    const bare = text.slice(text.lastIndexOf('@') + 1);" "    const bare = text;" \
    test/host-proxy.test.ts "CREDENTIALS NEVER SURVIVE"

probe "the-proxy-file-is-0600" src/main/proxy-memory.ts \
    " origins: Object.fromEntries(this.#origins) }, PRIVATE_FILE);" " origins: Object.fromEntries(this.#origins) });" \
    test/host-proxy.test.ts "the file is the owner"

probe "no-route-left-is-an-error-not-direct" src/main/host-https-fetch.ts \
    "            if (!next) throw failure;" "            if (!next) return send(target, init, agentFor({ kind: 'direct' }));" \
    test/host-proxy.test.ts "is refused by name, not sent direct"

probe "an-unresolved-host-keeps-its-answer" src/main/proxy-report.ts \
    "            options.log?.(" "            answers[host] = 'DIRECT'; options.log?.(" \
    test/host-proxy.test.ts "never sent as direct"


# P3.4 cut c: the host prepares its agents.
probe "the-host-hands-out-the-key" src/main/session-engine-server.ts \
    "                return [...own, ...(held?.servers ?? [])];" "                return own;" \
    test/host-prepares-agents.test.ts "minted by the host, held in the keychain"

probe "no-key-says-why" src/main/session-engine-server.ts \
    "                if (held?.note) this.#host?.notice(record.id, held.note);" "" \
    test/host-agent-keys.test.ts "its chat says why"

probe "only-the-signed-in-record-counts" src/main/tynn-account.ts \
    "if (data.state !== 'signed-in' || typeof data.userId !== 'string'" "if (typeof data.userId !== 'string'" \
    test/tynn-account-host.test.ts "it says signed out, whatever else it holds"

probe "the-vault-is-read-afresh" src/main/tynn-agent-identities.ts \
    "            text = await readFile(ports.file, 'utf8');" "            text = ((ports as never as { held?: string }).held ??= await readFile(ports.file, 'utf8'));" \
    test/host-prepares-agents.test.ts "THE VAULT IS READ AFRESH"

probe "moved-secrets-name-who-could-not-find-a-key" src/main/agent-tynn-prep.ts \
    "        if (asked.secretsMoved) for (const [id, code] of without) if (code === 'storage') named.add(id);" "" \
    test/host-prepares-agents.test.ts "after the one-time move"


# P3.4 cut c: the host restores Tynn tools with no window, and a workspace just added is never refused.
probe "never-through-a-running-turn" src/main/host-tynn-recovery.ts \
    "        if (live.inTurn === true) return;" "" \
    test/host-tynn-recovery.test.ts "mid-turn it waits"

probe "a-stopped-agent-stays-stopped" src/main/host-tynn-recovery.ts \
    "        if (!live || live.running === false) { owed.delete(id); return; }" "" \
    test/host-tynn-recovery.test.ts "A STOPPED AGENT IS NOT STARTED"

probe "the-heard-thread-is-resumed" src/main/host-tynn-recovery.ts \
    "threadId: ports.threadOf(id) ?? known.threadId" "threadId: known.threadId" \
    test/host-tynn-recovery.test.ts "A THREAD THE HOST HEARD WITH NO WINDOW"

probe "it-keeps-asking-while-someone-waits" src/main/host-tynn-recovery.ts \
    "                await ports.recheck().catch(() => {});" "" \
    test/host-tynn-recovery.test.ts "with an agent waiting on Tynn"

probe "a-start-waits-for-the-write" src/main/agent-tynn-prep.ts \
    "{ await options.settled?.(); workspace = known(); checkStop(); }" "{ workspace = known(); checkStop(); }" \
    test/host-tynn-recovery.test.ts "the write has not landed when the start arrives"


echo "=== restored: every probed test file (green expected)"
if npx vitest run test/session-engine.test.ts test/agent-engine.test.ts test/genie-host-no-electron.test.ts test/spawn-relay.test.ts test/process-supervisor-adopt.test.ts test/spawn-host-link.test.ts test/terminal-open-ready.test.ts test/files-watch-hub.test.ts test/engine-files-tunnel.test.ts test/engine-cooling-replica.test.ts test/mcp-host-tools.test.ts test/agent-stores-contract.test.ts test/settings-drafts-contract.test.ts test/registry-host-contract.test.ts test/host-mail-wake.test.ts test/supervisor-host-contract.test.ts test/process-book-host-contract.test.ts test/flows-host-contract.test.ts test/terminals-host-contract.test.ts test/quit-sequence.test.ts test/quit-plan.test.ts test/tray-only.test.ts test/tray.test.ts test/quit-keeps-host-wiring.test.ts test/tray-confirm.test.ts test/runtime-file-modes.test.ts test/no-saved-scrollback.test.ts test/keychain.test.ts test/keychain-migration.test.ts test/host-agent-keys.test.ts test/tynn-account-host.test.ts test/host-https-fetch.test.ts test/host-proxy.test.ts test/host-prepares-agents.test.ts test/host-tynn-recovery.test.ts > "/tmp/probe-$$.log" 2>&1; then
    grep -E "Test Files|Tests " "/tmp/probe-$$.log"
else
    echo "RESTORE FAILED"; grep -E "×|FAIL|Tests " "/tmp/probe-$$.log" | head -10; fail=1
fi
rm -f "/tmp/probe-$$.orig" "/tmp/probe-$$.log"
exit $fail
