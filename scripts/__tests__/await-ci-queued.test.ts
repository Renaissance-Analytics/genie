import { describe, expect, it } from 'vitest';
import { awaitCiQueued } from '../assert-ci-queued.mjs';

/**
 * The polling half of the genie#574 guard.
 *
 * The verdict function is pure and tested separately; what is tested here is the
 * loop around it, which has its own failure modes and they are not theoretical:
 *
 *  - a loop that never re-reads gives up on every healthy PR (checks take a few
 *    seconds to register, so the FIRST observation is nearly always incomplete);
 *  - a loop that never terminates hangs a job until the runner kills it, which
 *    turns a check meant to save time into one that costs 30 minutes;
 *  - a loop that sleeps out its full budget before reporting a conflict turns an
 *    instant answer into a three-minute one, on the PR that is already broken.
 *
 * Time and the network are injected, so the whole thing runs in microseconds.
 */

type Snapshot = {
    mergeable: boolean | null;
    mergeableState: string;
    checkNames: string[];
    fromFork: boolean;
};

const ALL = [
    'test',
    'hosting',
    'E2E (ubuntu-latest)',
    'E2E (macos-latest)',
    'E2E (windows-latest)',
];

/** A fake clock: `sleep` advances it instead of waiting. */
function harness(snapshots: Snapshot[]) {
    let clock = 0;
    let reads = 0;
    const slept: number[] = [];
    return {
        get reads() {
            return reads;
        },
        get slept() {
            return slept;
        },
        deps: {
            observe: async () => {
                // Hold the last snapshot once the script has run out of them.
                const s = snapshots[Math.min(reads, snapshots.length - 1)];
                reads++;
                return s;
            },
            sleep: async (ms: number) => {
                slept.push(ms);
                clock += ms;
            },
            now: () => clock,
        },
    };
}

const PENDING: Snapshot = {
    mergeable: null,
    mergeableState: 'unknown',
    checkNames: [],
    fromFork: false,
};
const READY: Snapshot = {
    mergeable: true,
    mergeableState: 'clean',
    checkNames: ALL,
    fromFork: false,
};

describe('awaitCiQueued', () => {
    it('re-reads until the checks register, then reports satisfied', async () => {
        // The realistic sequence: GitHub is still computing mergeability, then the
        // shards register one after another. A single-shot check would fail all of
        // these healthy PRs.
        const h = harness([
            PENDING,
            { ...READY, checkNames: ['test'] },
            { ...READY, checkNames: ['test', 'hosting', 'E2E (ubuntu-latest)'] },
            READY,
        ]);
        const v = await awaitCiQueued({ ...h.deps, budgetMs: 180_000, intervalMs: 10_000 });
        expect(v.state).toBe('satisfied');
        expect(h.reads).toBe(4);
    });

    it('reports a conflicted PR on the FIRST read, without sleeping at all', async () => {
        const h = harness([
            { mergeable: false, mergeableState: 'dirty', checkNames: ['flag'], fromFork: false },
        ]);
        const v = await awaitCiQueued({ ...h.deps, budgetMs: 180_000, intervalMs: 10_000 });
        expect(v.state).toBe('blocked');
        expect(v.reason).toBe('not-mergeable');
        expect(h.reads).toBe(1);
        expect(h.slept).toEqual([]);
    });

    it('terminates at the budget and blocks, instead of polling forever', async () => {
        const h = harness([PENDING]);
        const v = await awaitCiQueued({ ...h.deps, budgetMs: 60_000, intervalMs: 10_000 });
        expect(v.state).toBe('blocked');
        expect(v.reason).toBe('checks-never-queued');
        // 6 sleeps of 10s exhausts a 60s budget; the loop must stop there.
        expect(h.slept.length).toBeLessThanOrEqual(7);
        expect(h.deps.now()).toBeGreaterThanOrEqual(60_000);
    });

    it('short-circuits a fork PR without burning the budget', async () => {
        const h = harness([{ ...PENDING, fromFork: true }]);
        const v = await awaitCiQueued({ ...h.deps, budgetMs: 180_000, intervalMs: 10_000 });
        expect(v.state).toBe('skipped');
        expect(h.slept).toEqual([]);
    });

    it('returns satisfied on the very first read when everything is already there', async () => {
        const h = harness([READY]);
        const v = await awaitCiQueued({ ...h.deps, budgetMs: 180_000, intervalMs: 10_000 });
        expect(v.state).toBe('satisfied');
        expect(h.reads).toBe(1);
        expect(h.slept).toEqual([]);
    });
});
