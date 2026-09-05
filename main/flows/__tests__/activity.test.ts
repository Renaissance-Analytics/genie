/**
 * What "a Flow is running right now" means, and when it stops being true.
 *
 * The header button animates off this. That makes correctness here a UX
 * property, not a bookkeeping one: a badge that says something is running when
 * nothing is is worse than no badge, because it trains the user to ignore it.
 * The failure modes are both real and both cheap to hit —
 *
 *  - a run that ends by THROWING never clears, and the header spins forever;
 *  - a Flow that was refused or loop-blocked never STARTED, and must not light
 *    the header on its way to being logged.
 *
 * so both are asserted below rather than assumed.
 *
 * ## Pure on purpose
 *
 * This is the whole of the live-state decision, with no database, no IPC and no
 * clock of its own. The tracker is handed starts and finishes and answers two
 * questions; production wires it to the runtime in `index.ts`. Nothing that
 * decides what the user sees is left sitting in a callback where it cannot be
 * tested.
 */

import { describe, expect, it } from 'vitest';
import { FlowActivity } from '../activity';
import type { FlowRunLog } from '../runtime';

function log(over: Partial<FlowRunLog> = {}): FlowRunLog {
    return {
        flowId: 'f1',
        runId: 'r1',
        outcome: 'ran',
        at: 1_000,
        ...over,
    };
}

describe('FlowActivity — which Flows are running', () => {
    it('is quiet until something starts', () => {
        const a = new FlowActivity();
        expect(a.runningFlowIds()).toEqual([]);
        expect(a.isBusy()).toBe(false);
    });

    it('reports a Flow as running between its start and its finish', () => {
        const a = new FlowActivity();

        a.started({ flowId: 'f1', runId: 'r1', at: 100 });
        expect(a.runningFlowIds()).toEqual(['f1']);
        expect(a.isBusy()).toBe(true);

        a.finished(log({ at: 350 }));
        expect(a.runningFlowIds()).toEqual([]);
        expect(a.isBusy()).toBe(false);
    });

    it('clears a run that ended by FAILING, not just one that succeeded', () => {
        const a = new FlowActivity();
        a.started({ flowId: 'f1', runId: 'r1', at: 100 });

        a.finished(log({ outcome: 'failed', reason: 'ENOENT', at: 120 }));

        // The animation must stop when the body threw. This is the one that
        // spins forever if `finished` is only called on the happy path.
        expect(a.isBusy()).toBe(false);
    });

    it('does NOT light up for a Flow that never started', () => {
        const a = new FlowActivity();

        // Refused / blocked / error outcomes are logged without a start: the
        // body was never entered.
        a.finished(log({ runId: 'r-blocked', outcome: 'blocked', reason: 'the loop guard held it' }));
        a.finished(log({ runId: 'r-refused', outcome: 'refused', reason: 'not installed' }));

        expect(a.isBusy()).toBe(false);
        expect(a.runningFlowIds()).toEqual([]);
    });

    it('tracks concurrent runs, and stays busy until the LAST one finishes', () => {
        const a = new FlowActivity();
        a.started({ flowId: 'f1', runId: 'r1', at: 10 });
        a.started({ flowId: 'f2', runId: 'r2', at: 12 });

        a.finished(log({ flowId: 'f1', runId: 'r1', at: 20 }));

        // f1 is done; f2 is not. A tracker that counted runs rather than keying
        // them would go quiet here.
        expect(a.runningFlowIds()).toEqual(['f2']);
        expect(a.isBusy()).toBe(true);

        a.finished(log({ flowId: 'f2', runId: 'r2', at: 30 }));
        expect(a.isBusy()).toBe(false);
    });

    it('reports one Flow once while two of its own runs overlap', () => {
        const a = new FlowActivity();
        a.started({ flowId: 'f1', runId: 'r1', at: 10 });
        a.started({ flowId: 'f1', runId: 'r2', at: 11 });

        expect(a.runningFlowIds()).toEqual(['f1']);

        a.finished(log({ runId: 'r1', at: 20 }));
        // Still running: the OTHER run of the same Flow is live. A set keyed by
        // flow id rather than run id would go dark here with work in flight.
        expect(a.runningFlowIds()).toEqual(['f1']);

        a.finished(log({ runId: 'r2', at: 21 }));
        expect(a.runningFlowIds()).toEqual([]);
    });
});

describe('FlowActivity — the record a finish produces', () => {
    it('times the run from its start, so the manager can say how long it took', () => {
        const a = new FlowActivity();
        a.started({ flowId: 'f1', runId: 'r1', event: 'files:added', at: 100 });

        const record = a.finished(log({ event: 'files:added', at: 450 }));

        expect(record).toEqual({
            runId: 'r1',
            flowId: 'f1',
            event: 'files:added',
            outcome: 'ran',
            startedAt: 100,
            finishedAt: 450,
        });
    });

    it('records a never-started outcome as instantaneous, with its reason', () => {
        const a = new FlowActivity();

        const record = a.finished(
            log({ runId: 'r9', outcome: 'blocked', reason: 'the loop guard held it', at: 700 }),
        );

        // No start means no duration to invent. Reporting a made-up one would be
        // the manager asserting something it does not know.
        expect(record).toEqual({
            runId: 'r9',
            flowId: 'f1',
            outcome: 'blocked',
            reason: 'the loop guard held it',
            startedAt: 700,
            finishedAt: 700,
        });
    });

    it('forgets a finished run, so a duplicate finish cannot resurrect it', () => {
        const a = new FlowActivity();
        a.started({ flowId: 'f1', runId: 'r1', at: 100 });
        a.finished(log({ at: 200 }));

        const second = a.finished(log({ at: 300 }));

        // The second finish is treated as never-started rather than re-using the
        // stale start — otherwise a duplicate log would report a run that lasted
        // from the original start to now.
        expect(second.startedAt).toBe(300);
        expect(a.isBusy()).toBe(false);
    });
});
