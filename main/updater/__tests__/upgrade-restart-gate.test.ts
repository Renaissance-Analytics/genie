import { describe, expect, it, vi } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { AgentDrain, type DrainTarget } from '../../agents/drain';
import { UpgradeRestartGate } from '../restart-gate';

/**
 * THE UPGRADE WAITS FOR THE AGENTS (genie#565).
 *
 * genie#389 built the drain and wired it to ONE door — the `updater:restart`
 * IPC. Two others reached `restartAndApply` directly: the hands-free apply that
 * `downloadAndInstall` arms (*"one user click drives download → install →
 * restart with no further prompts"*) and the phone's `mobileInstallUpdate`. So
 * the property the drain exists to hold — no agent is killed by an upgrade
 * without being asked first — was true of the button and false of the path.
 *
 * This is that path, extracted from the IPC layer so it can be exercised
 * against the REAL {@link AgentDrain} with no Electron, no database and no
 * updater around it. Every door now calls `request`, and there is nothing else
 * to call.
 */

/** A drain wired to fakes, with the stuck deadline under the test's control. */
function stagedDrain(names: string[]) {
    const sent: string[] = [];
    let fireDeadline: (() => void) | null = null;
    const drain = new AgentDrain({
        send: (inboxAgentId, notice) => {
            sent.push(`${inboxAgentId}:${notice.text.slice(0, 24)}`);
            return true;
        },
        schedule: (run) => {
            fireDeadline = run;
            return () => {
                fireDeadline = null;
            };
        },
    });
    const targets: DrainTarget[] = names.map((name, i) => ({
        agentId: `a${i}`,
        inboxAgentId: `inbox-${i}`,
        terminalId: `t${i}`,
        name,
        workspaceId: 'w',
    }));
    return {
        drain,
        targets,
        sent,
        /** Fire the stuck deadline by hand — three real minutes, instantly. */
        elapsePastStuck: () => fireDeadline?.(),
    };
}

/** The gate, with counters for everything it is allowed to do. */
function stagedGate(opts: {
    liveAgents: number | null;
    drainCleared?: boolean;
    beginDrain: () => Promise<{ complete: boolean }>;
    applyThrows?: string;
}) {
    const calls = { apply: 0, markCleared: 0, markForced: 0 };
    let cleared = opts.drainCleared ?? false;
    const gate = new UpgradeRestartGate({
        liveAgents: () => opts.liveAgents,
        drainCleared: () => cleared,
        beginDrain: opts.beginDrain,
        markDrainCleared: () => {
            cleared = true;
            calls.markCleared++;
        },
        markForced: () => {
            calls.markForced++;
        },
        applyNow: () => {
            calls.apply++;
            if (opts.applyThrows) throw new Error(opts.applyThrows);
        },
    });
    return { gate, calls };
}

describe('an upgrade with every agent green PROCEEDS', () => {
    it('nudges both agents, waits, and applies the instant the last thumb lands', async () => {
        const staged = stagedDrain(['claude', 'codex']);
        const { gate, calls } = stagedGate({
            liveAgents: 2,
            beginDrain: () => staged.drain.begin(staged.targets),
        });

        const result = gate.request();
        // Nothing has restarted: the answer is "we are asking them".
        expect(result).toEqual({ ok: true, draining: true });
        expect(calls.apply).toBe(0);
        expect(staged.sent).toHaveLength(2);

        staged.drain.acknowledge('a0', 'shutdown');
        await Promise.resolve();
        // ONE agent green is not enough. This is the half of the property that
        // a "wait a bit then go" implementation would still pass.
        expect(calls.apply).toBe(0);

        staged.drain.acknowledge('a1', 'shutdown');
        await new Promise((r) => setImmediate(r));

        expect(calls.apply).toBe(1);
        expect(calls.markCleared).toBe(1);
        // A drain that cleared is not a force, and must never be recorded as one.
        expect(calls.markForced).toBe(0);
    });

    it('applies straight away when there is no agent to ask', async () => {
        const beginDrain = vi.fn();
        const { gate, calls } = stagedGate({ liveAgents: 0, beginDrain });
        expect(gate.request()).toEqual({ ok: true });
        expect(calls.apply).toBe(1);
        expect(beginDrain).not.toHaveBeenCalled();
    });
});

describe('an upgrade with one agent SILENT does not restart on its own', () => {
    it('holds forever past the stuck deadline — the label changes, the wait does not', async () => {
        const staged = stagedDrain(['claude', 'wedged']);
        const { gate, calls } = stagedGate({
            liveAgents: 2,
            beginDrain: () => staged.drain.begin(staged.targets),
        });
        gate.request();

        staged.drain.acknowledge('a0', 'shutdown');
        await new Promise((r) => setImmediate(r));
        expect(calls.apply).toBe(0);

        // Three minutes pass. The whole point: this must relabel, not proceed.
        staged.elapsePastStuck();
        await new Promise((r) => setImmediate(r));

        expect(calls.apply).toBe(0);
        expect(calls.markCleared).toBe(0);
        expect(staged.drain.active()).toBe(true);

        const row = staged.drain.snapshot().rows.find((r) => r.name === 'wedged');
        // Visible, so Force Restart is an informed choice and not a guess.
        expect(row?.state).toBe('stuck');
        expect(row?.note).toBeTruthy();
    });

    it('a second click while draining does not nudge anyone twice', async () => {
        const staged = stagedDrain(['claude']);
        const { gate } = stagedGate({
            liveAgents: 1,
            beginDrain: () => staged.drain.begin(staged.targets),
        });
        gate.request();
        expect(gate.request()).toEqual({ ok: true, draining: true });
        expect(staged.sent).toHaveLength(1);
    });

    it('a CANCELLED drain applies nothing — that is the difference from a timeout', async () => {
        const staged = stagedDrain(['claude']);
        const { gate, calls } = stagedGate({
            liveAgents: 1,
            beginDrain: () => staged.drain.begin(staged.targets),
        });
        gate.request();
        staged.drain.cancel();
        await new Promise((r) => setImmediate(r));
        expect(calls.apply).toBe(0);
        expect(calls.markCleared).toBe(0);
        // And the door is usable again, rather than wedged "draining" forever.
        expect(gate.isDraining()).toBe(false);
    });
});

describe('FORCE RESTART proceeds regardless', () => {
    it('applies over a roster that has not cleared', async () => {
        const staged = stagedDrain(['claude', 'wedged']);
        const { gate, calls } = stagedGate({
            liveAgents: 2,
            beginDrain: () => staged.drain.begin(staged.targets),
        });
        gate.request();
        expect(calls.apply).toBe(0);

        expect(gate.request({ force: true })).toEqual({ ok: true });
        expect(calls.apply).toBe(1);
        expect(calls.markForced).toBe(1);
        // Forcing is NOT the agents answering. Recording it as a cleared drain
        // would claim a thumb nobody pressed.
        expect(calls.markCleared).toBe(0);
    });

    it('does not cancel the drain, because cancelling drops the restore roster', () => {
        // `cancelUpgradeDrain` clears the list of what to bring back after the
        // upgrade (genie#551). A force still tears those agents down, so the
        // list is exactly what it needs.
        const staged = stagedDrain(['claude']);
        const { gate } = stagedGate({
            liveAgents: 1,
            beginDrain: () => staged.drain.begin(staged.targets),
        });
        gate.request();
        gate.request({ force: true });
        expect(staged.drain.snapshot().complete).toBe(false);
        expect(staged.drain.active()).toBe(true);
    });

    it('forces with no drain running at all', () => {
        const beginDrain = vi.fn();
        const { gate, calls } = stagedGate({ liveAgents: 4, beginDrain });
        expect(gate.request({ force: true })).toEqual({ ok: true });
        expect(calls.apply).toBe(1);
        expect(beginDrain).not.toHaveBeenCalled();
    });
});

describe('the gate reports failures instead of restarting behind the user', () => {
    it('reports a refused apply rather than rejecting the caller', () => {
        const { gate } = stagedGate({
            liveAgents: 0,
            beginDrain: vi.fn(),
            applyThrows: 'No update has been downloaded yet.',
        });
        expect(gate.request()).toEqual({
            ok: false,
            error: 'No update has been downloaded yet.',
        });
    });

    it('a drain that cannot even START must not apply the update', () => {
        const { gate, calls } = stagedGate({
            liveAgents: 2,
            beginDrain: () => {
                throw new Error('the broker is down');
            },
        });
        const result = gate.request();
        expect(result.ok).toBe(false);
        expect(result.error).toContain('the broker is down');
        expect(calls.apply).toBe(0);
        // And it must not wedge: the user can still force past it.
        expect(gate.isDraining()).toBe(false);
    });

    it('an unreadable agent count drains rather than guessing zero', () => {
        const staged = stagedDrain(['claude']);
        const { gate, calls } = stagedGate({
            liveAgents: null,
            beginDrain: () => staged.drain.begin(staged.targets),
        });
        expect(gate.request()).toEqual({ ok: true, draining: true });
        expect(calls.apply).toBe(0);
    });
});

/**
 * AND NO FOURTH DOOR (genie#565).
 *
 * The bug was not that someone wrote a bad check — it was that
 * `restartAndApply()` was callable from anywhere, and over time three places
 * called it while only one of them asked the agents first. The comment in the
 * IPC handler asserting otherwise was written in good faith and was simply
 * false, and nothing in the suite could tell.
 *
 * So the invariant is asserted rather than described. Exactly two call sites
 * are legitimate: the gate's own `applyNow`, and the auto-updater's fallback
 * for the window before the gate is wired. A third is a door that skips the
 * drain, and this is what says so.
 */
describe('restartAndApply is reachable only through the gate', () => {
    const roots = ['main', 'renderer', 'e2e'];

    /** Source lines with `//` comments removed. Split on `\r?\n`: these files
     *  are CRLF, and a `\n` split would leave a trailing `\r` on every line —
     *  harmless here, but it is how a guard like this silently goes inert. */
    function codeLines(file: string): string[] {
        return readFileSync(file, 'utf8')
            .split(/\r?\n/)
            .map((line) => line.replace(/\/\/.*$/, ''))
            .filter((line) => !/^\s*\*/.test(line));
    }

    function sourceFiles(dir: string): string[] {
        const out: string[] = [];
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
            const full = join(dir, entry.name);
            if (entry.isDirectory()) {
                if (entry.name === 'node_modules' || entry.name === '__tests__') continue;
                out.push(...sourceFiles(full));
            } else if (/\.tsx?$/.test(entry.name)) {
                out.push(full);
            }
        }
        return out;
    }

    const callSites = roots
        .flatMap((root) => sourceFiles(resolve(__dirname, '../../..', root)))
        .flatMap((file) =>
            codeLines(file)
                .map((line, i) => ({ file, line: i + 1, text: line }))
                .filter((row) => /\.restartAndApply\s*\(/.test(row.text)),
        );

    it('finds the call sites it is meant to be guarding', () => {
        // The positive control. A guard that walked the wrong tree, or whose
        // comment-stripping ate every line, would report zero call sites and
        // pass forever while the invariant rotted.
        expect(callSites.length).toBeGreaterThan(0);
    });

    it('has exactly the two the design allows, and no others', () => {
        // Matched with `join`, so the separator is whatever the walk produced.
        // This suite runs on Windows locally and Linux in CI, and a hardcoded
        // '/' would quietly match nothing on one of them — a guard that passes
        // by finding zero of everything.
        const files = callSites.map((row) => row.file);
        const inUpdater = (name: string) =>
            files.filter((f) => f.endsWith(join('main', 'updater', name)));

        // The gate's own apply, injected where the gate is constructed.
        expect(inUpdater('ipc.ts')).toHaveLength(1);
        // The auto-updater's fallback for the window before `setRestartRequest`
        // has run, when there is no agent domain wired up to drain yet.
        expect(inUpdater('auto-updater.ts')).toHaveLength(1);
        // The gate reaches it only through the injected `applyNow`.
        expect(inUpdater('restart-gate.ts')).toHaveLength(0);
        expect(files).toHaveLength(2);
    });
});
