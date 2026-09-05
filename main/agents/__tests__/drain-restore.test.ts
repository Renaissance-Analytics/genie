import { describe, expect, it, vi } from 'vitest';
import {
    DRAIN_RESTORE_GAP_MS,
    planDrainRestore,
    runDrainRestore,
    type DrainRestoreEntry,
} from '../drain-restore';

/**
 * THE RESTORE HALF (genie#389).
 *
 * A drain that stops everything and leaves it stopped just moves the work onto
 * the user, so the roster built for the drain is also the restore list. Two
 * rules govern it, and they pull in opposite directions:
 *
 *  - **Nothing drained is left down.** Every agent, site and background process
 *    that was RUNNING when the drain began comes back, and a start that fails
 *    does not abort the rest of the queue.
 *  - **Genie may restore what IT stopped; it must never restart what the USER
 *    stopped** (genie#407). The durable desired state landed in genie#412 —
 *    `site_run_state` for sites, `meta.user_stopped` for processes — and the
 *    restore READS it. Restoring on any broader rule resurrects exactly what
 *    the user deliberately switched off, at the moment they are least able to
 *    tell the difference.
 *
 * And the starts are STAGGERED. A dozen cold starts in one tick on a machine
 * that has just finished an upgrade is a thundering herd: agent TUIs are full
 * harness processes, sites bind ports, and toolchain-backed processes contend
 * on the same binaries. 3 seconds is the floor the issue sets.
 *
 * Every "was not started" assertion below carries a POSITIVE CONTROL in the
 * same test — a sibling that DOES start — because "nothing was started" is also
 * what a restore that starts nothing at all looks like.
 */

const AGENT: DrainRestoreEntry = {
    kind: 'agent',
    ref: 'ws1:moic',
    label: 'moic',
    workspaceId: 'ws1',
};
const SITE_UP: DrainRestoreEntry = {
    kind: 'site',
    ref: 'ws1/web',
    label: 'web',
    workspaceId: 'ws1',
};
const SITE_DOWN: DrainRestoreEntry = {
    kind: 'site',
    ref: 'ws1/api',
    label: 'api',
    workspaceId: 'ws1',
};
const PROC_UP: DrainRestoreEntry = {
    kind: 'process',
    ref: 'proc-queue',
    label: 'queue',
    workspaceId: 'ws1',
};
const PROC_DOWN: DrainRestoreEntry = {
    kind: 'process',
    ref: 'proc-vite',
    label: 'vite',
    workspaceId: 'ws1',
};

/** Desired state as genie#412 records it. Absence means "not user-stopped". */
function desired(stopped: string[] = []) {
    return {
        siteStoppedByUser: (siteId: string) => stopped.includes(siteId),
        processStoppedByUser: (specId: string) => stopped.includes(specId),
    };
}

describe('planDrainRestore — what the restore may start', () => {
    it('starts everything that was drained, in roster order', () => {
        const plan = planDrainRestore([AGENT, SITE_UP, PROC_UP], desired());
        expect(plan.map((d) => d.entry.ref)).toEqual(['ws1:moic', 'ws1/web', 'proc-queue']);
        expect(plan.every((d) => d.start)).toBe(true);
    });

    it('does NOT restart a site the user stopped — and DOES restart its sibling', () => {
        const plan = planDrainRestore([SITE_UP, SITE_DOWN], desired(['ws1/api']));
        const byRef = Object.fromEntries(plan.map((d) => [d.entry.ref, d]));

        expect(byRef['ws1/api']!.start).toBe(false);
        expect(byRef['ws1/api']!.reason).toMatch(/stopped it/i);
        // The positive control. Without it this test passes against a planner
        // that starts nothing.
        expect(byRef['ws1/web']!.start).toBe(true);
    });

    it('does NOT restart a process the user paused — and DOES restart its sibling', () => {
        const plan = planDrainRestore([PROC_UP, PROC_DOWN], desired(['proc-vite']));
        const byRef = Object.fromEntries(plan.map((d) => [d.entry.ref, d]));

        expect(byRef['proc-vite']!.start).toBe(false);
        expect(byRef['proc-vite']!.reason).toMatch(/paused|stopped it/i);
        expect(byRef['proc-queue']!.start).toBe(true);
    });

    it('asks the SITE predicate about sites and the PROCESS predicate about processes', () => {
        // One shared predicate would let a site id that happens to match a
        // paused process id silently suppress a site — and vice versa. The two
        // stores are separate facts and are consulted separately.
        const siteStoppedByUser = vi.fn().mockReturnValue(false);
        const processStoppedByUser = vi.fn().mockReturnValue(false);
        planDrainRestore([SITE_UP, PROC_UP], { siteStoppedByUser, processStoppedByUser });

        expect(siteStoppedByUser).toHaveBeenCalledWith('ws1/web');
        expect(siteStoppedByUser).not.toHaveBeenCalledWith('proc-queue');
        expect(processStoppedByUser).toHaveBeenCalledWith('proc-queue');
        expect(processStoppedByUser).not.toHaveBeenCalledWith('ws1/web');
    });

    it('does NOT start something that is ALREADY running', () => {
        // The roster outlives a crash. If Genie dies between the drain and the
        // upgrade — or the user cancels the restart after the roster is
        // written — the next launch finds a restore list for things that were
        // never stopped. `startProcess` on a live process is a RESTART and
        // `manager.start` on a live site can be too, so a blind restore would
        // bounce exactly what it was meant to protect.
        const plan = planDrainRestore([SITE_UP, SITE_DOWN], {
            ...desired(),
            alreadyRunning: (entry) => entry.ref === 'ws1/web',
        });
        const byRef = Object.fromEntries(plan.map((d) => [d.entry.ref, d]));

        expect(byRef['ws1/web']!.start).toBe(false);
        expect(byRef['ws1/web']!.reason).toMatch(/already running/i);
        // The positive control: its sibling, which is down, still starts.
        expect(byRef['ws1/api']!.start).toBe(true);
    });

    it('starts everything when nothing is reported running — the default', () => {
        // `alreadyRunning` is optional, and its absence must not be read as
        // "everything is up", which would restore nothing at all.
        const plan = planDrainRestore([SITE_UP, PROC_UP], desired());
        expect(plan.every((d) => d.start)).toBe(true);
    });

    it('restarts an AGENT unconditionally — there is no user-stopped agent', () => {
        // An agent the user satisfied BY HAND in the drain's stuck path is still
        // an agent that was running, and is still restarted.
        const plan = planDrainRestore([AGENT], desired(['ws1:moic']));
        expect(plan[0]!.start).toBe(true);
    });
});

describe('runDrainRestore — staggered, and nothing aborts the queue', () => {
    /** A restore whose clock the test drives, recording when each start ran. */
    function harness(over: Partial<Parameters<typeof runDrainRestore>[0]> = {}) {
        let clock = 0;
        const started: Array<{ ref: string; at: number }> = [];
        const run = (roster: DrainRestoreEntry[], desiredState = desired()) =>
            runDrainRestore({
                roster,
                desired: desiredState,
                now: () => clock,
                wait: async (ms) => {
                    clock += ms;
                },
                start: (entry) => {
                    started.push({ ref: entry.ref, at: clock });
                },
                ...over,
            });
        return { run, started, clockAt: () => clock };
    }

    it('leaves at least 3 seconds between starts', async () => {
        const { run, started } = harness();
        await run([AGENT, SITE_UP, PROC_UP]);

        expect(started.map((s) => s.ref)).toEqual(['ws1:moic', 'ws1/web', 'proc-queue']);
        for (let i = 1; i < started.length; i++) {
            expect(started[i]!.at - started[i - 1]!.at).toBeGreaterThanOrEqual(
                DRAIN_RESTORE_GAP_MS,
            );
        }
        expect(DRAIN_RESTORE_GAP_MS).toBeGreaterThanOrEqual(3_000);
    });

    it('does not wait before the FIRST start — the gap is between, not in front', async () => {
        const { run, started } = harness();
        await run([AGENT]);
        expect(started[0]!.at).toBe(0);
    });

    it('a SKIPPED entry costs no gap — nothing was started to contend with', async () => {
        const { run, started } = harness();
        await run([SITE_DOWN, SITE_UP], desired(['ws1/api']));

        expect(started.map((s) => s.ref)).toEqual(['ws1/web']);
        expect(started[0]!.at).toBe(0);
    });

    it('a start that FAILS does not abort the rest of the queue, and is reported', async () => {
        const started: string[] = [];
        const outcomes = await runDrainRestore({
            roster: [SITE_UP, PROC_UP, AGENT],
            desired: desired(),
            now: () => 0,
            wait: async () => {},
            start: (entry) => {
                if (entry.ref === 'ws1/web') throw new Error('port 5173 is taken');
                started.push(entry.ref);
            },
        });

        expect(started).toEqual(['proc-queue', 'ws1:moic']);
        const failed = outcomes.find((o) => o.entry.ref === 'ws1/web');
        expect(failed?.status).toBe('failed');
        expect(failed?.reason).toContain('port 5173 is taken');
        expect(outcomes.filter((o) => o.status === 'started')).toHaveLength(2);
    });

    it('a start that REJECTS is caught the same way a throw is', async () => {
        const outcomes = await runDrainRestore({
            roster: [SITE_UP, PROC_UP],
            desired: desired(),
            now: () => 0,
            wait: async () => {},
            start: async (entry) => {
                if (entry.ref === 'ws1/web') throw new Error('docker is not running');
            },
        });
        expect(outcomes[0]!.status).toBe('failed');
        expect(outcomes[1]!.status).toBe('started');
    });

    it('reports every outcome on the same roster, as each lands', async () => {
        const onOutcome = vi.fn();
        await runDrainRestore({
            roster: [SITE_DOWN, SITE_UP],
            desired: desired(['ws1/api']),
            now: () => 0,
            wait: async () => {},
            start: () => {},
            onOutcome,
        });
        expect(onOutcome.mock.calls.map((c) => [c[0].entry.ref, c[0].status])).toEqual([
            ['ws1/api', 'skipped'],
            ['ws1/web', 'started'],
        ]);
    });
});
