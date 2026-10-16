import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { mintAgentId } from '../src/core/identity.js';
import { makeProcessTree, type ProcessTreeIo } from '../src/core/process-tree.js';
import { openDurableStore } from '../src/core/thread-store.js';
import { AgentSession, type SessionDriverFactory } from '../src/core/session.js';

/**
 * STOP REAPS WHAT THE PROVIDER'S KILL ORPHANS.
 *
 * Found by the installed-app acceptance in the Windows VM (2026-10-15, checks 4b2 / 4f / 5b / 6c): after
 * `Genie --quit` an agent's provider process was still running. prism-acp spawns a provider through `cmd.exe` on
 * Windows (`shell: true`) and its kill is `child.kill()` — that `cmd.exe` only. The provider under it lives on with a
 * dead parent. `AgentSession.stop()` then reaped its owned pids, but checked "still ours" with a walk taken AFTER the
 * kill, from Genie's pid — and an orphan is not reachable from Genie's pid any more. So it was skipped, every time.
 *
 * The process table here is a fake with parent pointers, walked the way `win32Descendants` walks WMI
 * `ParentProcessId`. Nothing is spawned and nothing on the machine is touched: `makeProcessTree` is the real rule set,
 * the io under it is this table.
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

/** A process table: pid → parent pid. `descendants` walks it; `killOne` records the kill and removes the pid. */
function table(initial: Record<number, number>) {
    const parent = new Map<number, number>(Object.entries(initial).map(([pid, ppid]) => [Number(pid), ppid]));
    const kills: number[] = [];
    let walks = 0;
    const io: ProcessTreeIo = {
        descendants(root) {
            walks += 1;
            const out: number[] = [];
            const queue = [root];
            while (queue.length > 0) {
                const head = queue.shift()!;
                for (const [pid, ppid] of parent) {
                    if (ppid === head && !out.includes(pid)) { out.push(pid); queue.push(pid); }
                }
            }
            return out;
        },
        killOne(pid) { kills.push(pid); parent.delete(pid); },
    };
    return {
        tree: makeProcessTree(io, () => SELF),
        spawn: (pid: number, ppid: number) => { parent.set(pid, ppid); },
        exit: (pid: number) => { parent.delete(pid); },
        alive: (pid: number) => parent.has(pid),
        killsOf: (pid: number) => kills.filter((k) => k === pid).length,
        walks: () => walks,
    };
}

/** A driver that spawns `cmd.exe` → provider on start, and whose kill ends whatever `onKill` says. */
function driverOver(t: ReturnType<typeof table>, onKill: () => void): SessionDriverFactory {
    return () => ({
        start: () => { t.spawn(CMD, SELF); t.spawn(PROVIDER, CMD); },
        prompt: () => {},
        kill: () => onKill(),
        cliSessionId: null,
    });
}

describe('AgentSession.stop — the provider a shell-wrapped kill orphans', () => {
    it('reaps the provider exactly once when the kill took only the cmd.exe above it — and never a process that was not the session’s', () => {
        // A terminal's pty helper, Genie's before the session started: a descendant of Genie, never the session's.
        const t = table({ [TERMINAL_HELPER]: SELF });
        const dir = tempDir();
        const session = new AgentSession({
            agentId: mintAgentId(), cwd: dir, store: openDurableStore(dir),
            // prism-acp on Windows: `child.kill()` is TerminateProcess on the cmd.exe, and nothing else.
            driverFactory: driverOver(t, () => t.exit(CMD)),
            processTree: t.tree,
        });
        session.start();
        expect(t.alive(PROVIDER)).toBe(true);

        session.stop();

        expect(t.killsOf(PROVIDER)).toBe(1);
        expect(t.alive(PROVIDER)).toBe(false);
        // CONTROL, same run, same walk: the gauge that found the provider did not take Genie's other child with it.
        expect(t.killsOf(TERMINAL_HELPER)).toBe(0);
        expect(t.alive(TERMINAL_HELPER)).toBe(true);
    });

    it('POSITIVE CONTROL: a kill that takes the whole tree leaves nothing alive and still spares the sibling', () => {
        const t = table({ [TERMINAL_HELPER]: SELF });
        const dir = tempDir();
        const killWholeTree = () => { t.exit(PROVIDER); t.exit(CMD); };
        const session = new AgentSession({
            agentId: mintAgentId(), cwd: dir, store: openDurableStore(dir),
            driverFactory: driverOver(t, killWholeTree),
            processTree: t.tree,
        });
        session.start();
        session.stop();

        expect(t.alive(CMD)).toBe(false);
        expect(t.alive(PROVIDER)).toBe(false);
        expect(t.killsOf(TERMINAL_HELPER)).toBe(0);
        expect(t.alive(TERMINAL_HELPER)).toBe(true);
    });

    it('costs the stop no extra walk: two at start (before/after), one at stop', () => {
        const t = table({});
        const dir = tempDir();
        const session = new AgentSession({
            agentId: mintAgentId(), cwd: dir, store: openDurableStore(dir),
            driverFactory: driverOver(t, () => t.exit(CMD)),
            processTree: t.tree,
        });
        session.start();
        expect(t.walks()).toBe(2);
        session.stop();
        expect(t.walks()).toBe(3);
    });
});

describe('ProcessTree.killTree with the caller’s pre-kill walk', () => {
    it('checks ownership against the walk it was GIVEN, not one taken now', () => {
        // Now: the provider's parent is gone, so a walk from Genie cannot reach it.
        const t = table({ [PROVIDER]: CMD });
        const result = t.tree.killTree([CMD, PROVIDER], [CMD, PROVIDER]);
        expect(t.killsOf(PROVIDER)).toBe(1);
        expect(result.refused).toBe(false);
        expect(t.walks()).toBe(0);
    });

    it('still kills nothing the given walk does not name', () => {
        const t = table({ [PROVIDER]: CMD, [TERMINAL_HELPER]: SELF });
        t.tree.killTree([PROVIDER, TERMINAL_HELPER], [PROVIDER]);
        expect(t.killsOf(PROVIDER)).toBe(1);
        expect(t.killsOf(TERMINAL_HELPER)).toBe(0);
    });

    it('still refuses an implausible walk, given or taken', () => {
        const t = table({ [PROVIDER]: CMD });
        const many = Array.from({ length: 40 }, (_, i) => 920_000 + i);
        const result = t.tree.killTree([PROVIDER], [PROVIDER, ...many]);
        expect(result.refused).toBe(true);
        expect(t.killsOf(PROVIDER)).toBe(0);
    });
});
