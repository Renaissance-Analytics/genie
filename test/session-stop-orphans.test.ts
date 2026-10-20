import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { mintAgentId } from '../src/core/identity.js';
import { openDurableStore } from '../src/core/thread-store.js';
import { AgentSession, type SessionDriverFactory } from '../src/core/session.js';
import { processTable } from './support/process-table.js';

/**
 * STOP REAPS WHAT THE PROVIDER'S KILL ORPHANS — on a REAL desktop, not a near-empty one.
 *
 * Found by the installed-app acceptance in the Windows VM (2026-10-15): after `Genie --quit` an agent's provider was
 * still running. prism-acp spawns a provider through `cmd.exe` on Windows (`shell: true`) and its kill is
 * `child.kill()` — that `cmd.exe` only. The provider under it lives on with a dead parent.
 *
 * Then found AGAIN, by the owner (2026-10-20, hosting review lifecycle F1): the reap that was meant to catch it was
 * REFUSED on every real desktop. The "plausibility cap" (24) was tested against ALL of Genie's descendants — 165 on the
 * owner's machine — instead of the session's own subtree, and the refusal was thrown away. Every Stop and every Restart
 * left `claude.exe` and its tree alive; a restart ran two Claudes on one conversation. The tests here used 2-9 process
 * tables, so the suite never saw a realistic tree. Every table below has Genie's other processes in it.
 *
 * The process table is a fake with parent pointers and start times, read the way the real snapshot reads WMI / ps.
 * Nothing is spawned and nothing on the machine is touched.
 */

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
function tempDir(): string {
    const d = mkdtempSync(join(tmpdir(), 'genie2-stop-orphans-'));
    dirs.push(d);
    return d;
}

const SELF = process.pid;
/** Pids far from anything real, so nothing here can be mistaken for a live process. */
const CMD = 910_001;
const PROVIDER = 910_002;
const TERMINAL_HELPER = 910_100;

/**
 * The owner's desktop at 11:50 on 2026-10-20, in shape: 165 descendants of Genie — terminals, sites, Caddy, php-cgi,
 * other agents — before this session starts. 25 pty helpers under Genie, each with a few children.
 */
function busyDesktop(t: ReturnType<typeof processTable>): number[] {
    const others: number[] = [];
    let pid = 930_000;
    for (let h = 0; h < 25; h++) {
        const helper = pid++;
        t.spawn(helper, SELF, 'fancy-pty-helper.exe');
        others.push(helper);
        for (let c = 0; c < 5; c++) { const child = pid++; t.spawn(child, helper, 'conhost.exe'); others.push(child); }
    }
    // Another agent, mid-tool: its cmd.exe, claude.exe, an MCP server and a Bash tool.
    for (let i = 0; i < 15; i++) { const p = pid++; t.spawn(p, others[i * 2] ?? SELF, 'node.exe'); others.push(p); }
    return others;
}

/** A driver that spawns `cmd.exe` → provider on start, and whose kill ends whatever `onKill` says. */
function driverOver(t: ReturnType<typeof processTable>, onKill: () => void, extra: () => void = () => {}): SessionDriverFactory {
    return () => ({
        start: () => { t.spawn(CMD, SELF, 'cmd.exe'); t.spawn(PROVIDER, CMD, 'claude.exe'); extra(); },
        prompt: () => {},
        kill: () => onKill(),
        cliSessionId: null,
    });
}

function session(t: ReturnType<typeof processTable>, driverFactory: SessionDriverFactory): AgentSession {
    const dir = tempDir();
    return new AgentSession({ agentId: mintAgentId(), cwd: dir, store: openDurableStore(dir), driverFactory, processTree: t.tree });
}

describe('AgentSession.stop on a busy desktop (165 Genie descendants) — the session’s tree, never Genie’s', () => {
    it('reaps every process of a 6-process session subtree when the kill took only the cmd.exe above it', async () => {
        const t = processTable(SELF);
        const others = busyDesktop(t);
        expect(others.length).toBe(165); // the cap must bite in this run, or it proves nothing
        const MCP = 910_010, NODE = 910_011, BASH = 910_012, PING = 910_013;
        const s = session(t, driverOver(t, () => t.exit(CMD)));
        s.start();
        // Claude's own children, started after the provider (an MCP server, a Bash tool running ping).
        t.spawn(MCP, PROVIDER, 'cmd.exe'); t.spawn(NODE, MCP, 'node.exe'); t.spawn(BASH, PROVIDER, 'bash.exe'); t.spawn(PING, BASH, 'ping.exe');

        const verdict = await s.stop();

        for (const pid of [CMD, PROVIDER, MCP, NODE, BASH, PING]) expect(t.alive(pid), `pid ${pid}`).toBe(false);
        expect(t.killsOf(PROVIDER)).toBe(1);
        expect(verdict).toMatchObject({ verified: true });
        // CONTROL, same run: not one of Genie's 165 other processes was touched.
        expect(others.filter((p) => t.killsOf(p) > 0)).toEqual([]);
        expect(others.every((p) => t.alive(p))).toBe(true);
    });

    it('REFUSES a 40-process SESSION subtree (the cap is on what the session would reap) — and says so in the verdict', async () => {
        const t = processTable(SELF);
        busyDesktop(t);
        const s = session(t, driverOver(t, () => t.exit(CMD)));
        s.start();
        for (let i = 0; i < 38; i++) t.spawn(911_000 + i, PROVIDER, 'node.exe');

        const verdict = await s.stop();

        expect(t.killsOf(PROVIDER)).toBe(0);
        expect(verdict.verified).toBe(false);
        if (!verdict.verified) {
            expect(verdict.reason).toMatch(/Refusing to reap 40 processes/);
            expect(verdict.survivors.map((p) => p.pid)).toContain(PROVIDER);
        }
    });

    it('a provider that appeared under the session’s shell AFTER the start snapshot is still reaped at stop', async () => {
        const t = processTable(SELF, [{ pid: TERMINAL_HELPER, ppid: SELF }]);
        const shellOnly: SessionDriverFactory = () => ({ start: () => { t.spawn(CMD, SELF, 'cmd.exe'); }, prompt: () => {}, kill: () => t.exit(CMD), cliSessionId: null });
        const s = session(t, shellOnly);
        s.start();
        t.spawn(PROVIDER, CMD, 'claude.exe');
        const LATE_CHILD = 910_003;
        t.spawn(LATE_CHILD, PROVIDER, 'bash.exe');

        await s.stop();

        expect(t.killsOf(PROVIDER)).toBe(1);
        expect(t.killsOf(LATE_CHILD)).toBe(1);
        expect(t.killsOf(TERMINAL_HELPER)).toBe(0);
    });

    it('a provider REPLACED under the shell after start (a re-exec: new pid) is reaped, not the pid it replaced', async () => {
        const t = processTable(SELF);
        const s = session(t, driverOver(t, () => t.exit(CMD)));
        s.start();
        const REEXEC = 910_004;
        t.exit(PROVIDER);
        t.spawn(REEXEC, CMD, 'claude.exe');

        await s.stop();

        expect(t.alive(REEXEC)).toBe(false);
        expect(t.killsOf(REEXEC)).toBe(1);
    });

    it('POSITIVE CONTROL: a kill that takes the whole tree leaves nothing alive and still spares the sibling', async () => {
        const t = processTable(SELF, [{ pid: TERMINAL_HELPER, ppid: SELF }]);
        const s = session(t, driverOver(t, () => { t.exit(PROVIDER); t.exit(CMD); }));
        s.start();
        const verdict = await s.stop();

        expect(t.alive(CMD)).toBe(false);
        expect(t.alive(PROVIDER)).toBe(false);
        expect(t.killsOf(TERMINAL_HELPER)).toBe(0);
        expect(verdict.verified).toBe(true);
    });
});

describe('ownership is the session’s own new child of Genie, never a diff of Genie’s whole tree (hosting plan 1.2)', () => {
    it('stopping A kills 0 of another agent’s processes and 0 of a terminal’s that appeared while A was starting', async () => {
        const B_CMD = 920_001, B_PROVIDER = 920_002, B_TOOL = 920_003, TERMINAL_CHILD = 920_004;
        const t = processTable(SELF, [
            { pid: TERMINAL_HELPER, ppid: SELF, name: 'fancy-pty-helper.exe' },
            { pid: B_CMD, ppid: SELF, name: 'cmd.exe' },
            { pid: B_PROVIDER, ppid: B_CMD, name: 'claude.exe' },
        ]);
        // In the instant between A's two scans, agent B's provider starts a Bash tool and a terminal's shell starts a
        // command: both appear under Genie, and neither is A's.
        const s = session(t, driverOver(t, () => t.exit(CMD), () => {
            t.spawn(B_TOOL, B_PROVIDER, 'bash.exe');
            t.spawn(TERMINAL_CHILD, TERMINAL_HELPER, 'php-cgi.exe');
        }));
        s.start();

        await s.stop();

        expect(t.alive(PROVIDER)).toBe(false);
        expect(t.killsOf(B_TOOL)).toBe(0);
        expect(t.killsOf(TERMINAL_CHILD)).toBe(0);
        expect(t.killsOf(B_PROVIDER)).toBe(0);
        expect(t.alive(B_TOOL) && t.alive(TERMINAL_CHILD) && t.alive(B_PROVIDER)).toBe(true);
    });

    it('a pid of the session reused by a stranger before the stop is not killed (same pid, a different start time)', async () => {
        const t = processTable(SELF);
        const s = session(t, driverOver(t, () => t.exit(CMD)));
        s.start();
        // The provider exits on its own and Windows hands its number to an unrelated process — parented under the
        // session's still-live cmd.exe by a stale pointer, but STARTED BEFORE that cmd.exe: it cannot be its child.
        t.exit(PROVIDER);
        t.spawn(PROVIDER, CMD, 'chrome.exe', 5);

        await s.stop();

        expect(t.killsOf(PROVIDER)).toBe(0);
        expect(t.alive(PROVIDER)).toBe(true);
    });

    it('costs what it must: two snapshots at start (before/after), one before the kill, one to verify', async () => {
        const t = processTable(SELF);
        const s = session(t, driverOver(t, () => t.exit(CMD)));
        s.start();
        expect(t.snapshots()).toBe(2);
        await s.stop();
        expect(t.snapshots()).toBe(4);
    });
});

describe('ProcessTree.killTree', () => {
    it('kills only targets that are the same process in the reading it was given (pid AND start time)', () => {
        const t = processTable(SELF, [{ pid: CMD, ppid: SELF }, { pid: PROVIDER, ppid: CMD }]);
        const now = t.tree.snapshot()!;
        const provider = t.row(PROVIDER)!;
        const stranger = { ...provider, pid: TERMINAL_HELPER };
        const result = t.tree.killTree([provider, stranger, { ...provider, started: provider.started + 1 }], now);
        expect(t.killsOf(PROVIDER)).toBe(1);
        expect(t.killsOf(TERMINAL_HELPER)).toBe(0);
        expect(result).toMatchObject({ refused: false, killed: 1 });
    });

    it('the cap is on the TARGETS: a 165-process reading with 6 targets reaps them; 40 targets refuse', () => {
        const t = processTable(SELF);
        const others = busyDesktop(t);
        const now = t.tree.snapshot()!;
        expect(now.length).toBeGreaterThan(165);
        const six = others.slice(0, 6).map((p) => t.row(p)!);
        expect(t.tree.killTree(six, now)).toMatchObject({ refused: false, killed: 6 });

        const forty = others.slice(10, 50).map((p) => t.row(p)!);
        const refused = t.tree.killTree(forty, t.tree.snapshot()!);
        expect(refused.refused).toBe(true);
        expect(refused.killed).toBe(0);
        expect(forty.every((p) => t.alive(p.pid))).toBe(true);
    });
});
