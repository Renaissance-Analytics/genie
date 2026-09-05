/**
 * Run history — the half of the Flow model that did not survive the process.
 *
 * `FlowRunLog` was built and handed to a callback that `console.log`s the
 * non-`ran` cases and drops the rest. So "did my Flow run last night, and what
 * happened" had no answer at all: the manager could show a list of Flows and
 * nothing about whether any of them had ever done anything.
 *
 * ## Refusals are history too
 *
 * `blocked`, `refused` and `error` are stored alongside `ran`. That is the
 * module's own stated principle applied to storage — a Flow silently not firing
 * is the hardest failure here to debug — and "last outcome: the loop guard held
 * it" is the answer that makes opening the manager worth doing. A store that
 * kept only successes would show a Flow that has been refused nightly for a week
 * as simply never having run.
 *
 * Exercised against a real in-memory better-sqlite3: migrations and SQL run for
 * real, so the fixture cannot be laxer than production.
 */

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { runMigrations } from '../../db';
import {
    deleteFlowRunsIn,
    lastFlowRunsIn,
    listFlowRunsIn,
    pruneFlowRunsIn,
    reconcileInterruptedFlowRunsIn,
    recordFlowRunIn,
    recordFlowRunStartIn,
} from '../run-store';
import type { FlowRunRecord } from '../run-store';

function db() {
    const d = new Database(':memory:');
    d.pragma('foreign_keys = ON');
    runMigrations(d);
    return d;
}

function record(over: Partial<FlowRunRecord> = {}): FlowRunRecord {
    return {
        runId: 'r1',
        flowId: 'f1',
        outcome: 'ran',
        startedAt: 1_000,
        finishedAt: 1_250,
        ...over,
    };
}

describe('recording a run', () => {
    it('round-trips everything the manager shows about it', () => {
        const d = db();
        recordFlowRunIn(
            d,
            record({ event: 'files:added', outcome: 'failed', reason: 'EACCES on the destination' }),
        );

        expect(listFlowRunsIn(d, 'f1')).toEqual([
            {
                runId: 'r1',
                flowId: 'f1',
                event: 'files:added',
                outcome: 'failed',
                reason: 'EACCES on the destination',
                startedAt: 1_000,
                finishedAt: 1_250,
            },
        ]);
    });

    it('keeps a refusal, not only a success', () => {
        const d = db();
        recordFlowRunIn(d, record({ runId: 'r-ok', outcome: 'ran', finishedAt: 10 }));
        recordFlowRunIn(
            d,
            record({ runId: 'r-no', outcome: 'blocked', reason: 'the loop guard held it', finishedAt: 20 }),
        );

        const outcomes = listFlowRunsIn(d, 'f1').map((r) => r.outcome);
        // Both, newest first — a store that dropped refusals would show a Flow
        // blocked every night as one that simply never ran.
        expect(outcomes).toEqual(['blocked', 'ran']);
    });

    it('lists newest first and honours a limit', () => {
        const d = db();
        for (let i = 1; i <= 5; i++) {
            recordFlowRunIn(d, record({ runId: `r${i}`, finishedAt: i * 100 }));
        }

        expect(listFlowRunsIn(d, 'f1', 2).map((r) => r.runId)).toEqual(['r5', 'r4']);
    });

    it('keeps each Flow to its own history', () => {
        const d = db();
        recordFlowRunIn(d, record({ runId: 'a', flowId: 'f1' }));
        recordFlowRunIn(d, record({ runId: 'b', flowId: 'f2' }));

        expect(listFlowRunsIn(d, 'f1').map((r) => r.runId)).toEqual(['a']);
        expect(listFlowRunsIn(d, 'f2').map((r) => r.runId)).toEqual(['b']);
    });

    it('re-recording the same run id replaces it rather than duplicating', () => {
        const d = db();
        recordFlowRunIn(d, record({ outcome: 'ran' }));
        recordFlowRunIn(d, record({ outcome: 'failed', reason: 'second thoughts' }));

        const runs = listFlowRunsIn(d, 'f1');
        expect(runs).toHaveLength(1);
        expect(runs[0]?.outcome).toBe('failed');
    });
});

describe('the last run of each Flow — the manager\'s list column', () => {
    it('answers for every Flow in one read', () => {
        const d = db();
        recordFlowRunIn(d, record({ runId: 'a1', flowId: 'f1', outcome: 'ran', finishedAt: 100 }));
        recordFlowRunIn(d, record({ runId: 'a2', flowId: 'f1', outcome: 'failed', finishedAt: 300 }));
        recordFlowRunIn(d, record({ runId: 'b1', flowId: 'f2', outcome: 'ran', finishedAt: 200 }));

        const last = lastFlowRunsIn(d);

        // Per Flow, not globally: f2's latest is older than f1's and must still
        // be reported. A single `ORDER BY finished_at DESC LIMIT 1` would answer
        // f1 for both.
        expect(last.get('f1')?.runId).toBe('a2');
        expect(last.get('f1')?.outcome).toBe('failed');
        expect(last.get('f2')?.runId).toBe('b1');
    });

    it('has nothing to say about a Flow that has never run', () => {
        const d = db();
        recordFlowRunIn(d, record({ flowId: 'f1' }));

        expect(lastFlowRunsIn(d).has('f-never')).toBe(false);
    });

    it('breaks a same-millisecond tie by insertion order rather than at random', () => {
        const d = db();
        recordFlowRunIn(d, record({ runId: 'first', finishedAt: 500 }));
        recordFlowRunIn(d, record({ runId: 'second', finishedAt: 500 }));

        expect(lastFlowRunsIn(d).get('f1')?.runId).toBe('second');
    });
});

describe('history does not grow forever', () => {
    it('prunes to the most recent N per Flow, keeping the newest', () => {
        const d = db();
        for (let i = 1; i <= 6; i++) {
            recordFlowRunIn(d, record({ runId: `f1-${i}`, flowId: 'f1', finishedAt: i * 10 }));
        }
        for (let i = 1; i <= 6; i++) {
            recordFlowRunIn(d, record({ runId: `f2-${i}`, flowId: 'f2', finishedAt: i * 10 }));
        }

        pruneFlowRunsIn(d, 2);

        // Per Flow, so a chatty Flow cannot evict a quiet one's entire history.
        expect(listFlowRunsIn(d, 'f1').map((r) => r.runId)).toEqual(['f1-6', 'f1-5']);
        expect(listFlowRunsIn(d, 'f2').map((r) => r.runId)).toEqual(['f2-6', 'f2-5']);
    });

    it('leaves a Flow with fewer runs than the cap alone', () => {
        const d = db();
        recordFlowRunIn(d, record({ runId: 'only' }));

        pruneFlowRunsIn(d, 50);

        expect(listFlowRunsIn(d, 'f1').map((r) => r.runId)).toEqual(['only']);
    });

    it('drops a deleted Flow\'s history with it', () => {
        const d = db();
        recordFlowRunIn(d, record({ runId: 'a', flowId: 'f1' }));
        recordFlowRunIn(d, record({ runId: 'b', flowId: 'f2' }));

        deleteFlowRunsIn(d, 'f1');

        expect(listFlowRunsIn(d, 'f1')).toEqual([]);
        // Positive control: the neighbouring Flow's history is untouched, so the
        // assertion above is about `f1` and not about the delete taking
        // everything.
        expect(listFlowRunsIn(d, 'f2').map((r) => r.runId)).toEqual(['b']);
    });
});

/**
 * A run that was in flight when the process died.
 *
 * Two different failures hide here, and only one of them is the obvious one.
 *
 * The obvious one is a permanently spinning header. Genie is safe from that by
 * construction — live state is `FlowActivity`'s in-memory map, which a crash
 * takes with it, so nothing can survive a restart claiming to be running. The
 * badge is rebuilt from nothing on every boot.
 *
 * The one that needed fixing is the opposite: with rows written only at the
 * FINISH, a run that started and never finished left NO TRACE AT ALL. The
 * manager would say "last run: yesterday" when in fact a run started last night
 * and Genie died on top of it — the history quietly omitting the single most
 * interesting thing that ever happened to that Flow.
 *
 * So a run is written when it STARTS, and boot converts anything still marked
 * running into `interrupted`. That is sound because of the same property that
 * makes the header safe: at boot nothing is running, so a `running` row is
 * orphaned by definition rather than by a guess about how old it is.
 */
describe('a run that never finished', () => {
    it('is recorded the moment it STARTS, not only when it ends', () => {
        const d = db();
        recordFlowRunStartIn(d, {
            runId: 'r1',
            flowId: 'f1',
            event: 'files:added',
            at: 500,
        });

        const runs = listFlowRunsIn(d, 'f1');
        expect(runs).toHaveLength(1);
        expect(runs[0]?.outcome).toBe('running');
        expect(runs[0]?.startedAt).toBe(500);
    });

    it('is REPLACED by its outcome when it finishes, not duplicated', () => {
        const d = db();
        recordFlowRunStartIn(d, { runId: 'r1', flowId: 'f1', at: 500 });
        recordFlowRunIn(d, record({ runId: 'r1', outcome: 'ran', startedAt: 500, finishedAt: 900 }));

        const runs = listFlowRunsIn(d, 'f1');
        expect(runs).toHaveLength(1);
        expect(runs[0]?.outcome).toBe('ran');
        expect(runs[0]?.finishedAt).toBe(900);
    });

    it('becomes `interrupted` at boot, because nothing is running at boot', () => {
        const d = db();
        recordFlowRunStartIn(d, { runId: 'orphan', flowId: 'f1', at: 100 });

        expect(reconcileInterruptedFlowRunsIn(d)).toBe(1);
        expect(listFlowRunsIn(d, 'f1')[0]?.outcome).toBe('interrupted');
        // It says WHY, so the row is an explanation rather than a mystery state.
        expect(listFlowRunsIn(d, 'f1')[0]?.reason).toContain('Genie stopped');
    });

    it('leaves finished runs completely alone', () => {
        const d = db();
        recordFlowRunIn(d, record({ runId: 'done', outcome: 'ran' }));
        recordFlowRunIn(d, record({ runId: 'bad', outcome: 'failed', reason: 'EACCES' }));
        recordFlowRunStartIn(d, { runId: 'orphan', flowId: 'f1', at: 100 });

        expect(reconcileInterruptedFlowRunsIn(d)).toBe(1);

        const byId = new Map(listFlowRunsIn(d, 'f1').map((r) => [r.runId, r]));
        // POSITIVE CONTROL for the count above: a reconcile that rewrote every
        // row would also return a number, and would destroy the history it
        // exists to complete.
        expect(byId.get('done')?.outcome).toBe('ran');
        expect(byId.get('bad')?.outcome).toBe('failed');
        expect(byId.get('bad')?.reason).toBe('EACCES');
        expect(byId.get('orphan')?.outcome).toBe('interrupted');
    });

    it('is a no-op on a clean shutdown, and says so with a zero', () => {
        const d = db();
        recordFlowRunIn(d, record({ runId: 'done', outcome: 'ran' }));

        expect(reconcileInterruptedFlowRunsIn(d)).toBe(0);
        expect(listFlowRunsIn(d, 'f1')[0]?.outcome).toBe('ran');
    });

    it('shows as the last run while it is still going', () => {
        const d = db();
        recordFlowRunIn(d, record({ runId: 'old', outcome: 'ran', finishedAt: 100 }));
        recordFlowRunStartIn(d, { runId: 'live', flowId: 'f1', at: 900 });

        // The list column reports the run in flight rather than the last
        // COMPLETED one — "running" is the honest answer to "what happened
        // last", and hiding it would show a stale success as current.
        expect(lastFlowRunsIn(d).get('f1')?.outcome).toBe('running');
    });
});
