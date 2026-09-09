import { describe, expect, it, vi, beforeEach } from 'vitest';

/**
 * A Flow that finished raises an alert (genie#546).
 *
 * The owner asked for this one by name — *"and when Flows run"*. A Flow is the
 * thing in Genie most likely to run while nobody is watching, which is exactly
 * the case a sound is for.
 *
 * Behavioural, through `runFlowManually`, with the RUNNER mocked so a test can
 * choose the outcome. Everything else the flow system touches at boot is mocked
 * to the smallest shape that lets the record-and-broadcast path execute.
 */

const runner = vi.hoisted(() => ({
    result: { ok: true } as { ok: boolean; error?: string; refusals?: unknown[] },
}));
vi.mock('../runner', () => ({
    runStoredFlow: () => Promise.resolve(runner.result),
}));
vi.mock('../store', () => ({
    getFlow: (id: string) => ({ id, title: 'Nightly sweep', enabled: true, graph: {} }),
    listFlows: () => [],
}));
vi.mock('../run-store', () => ({
    recordFlowRun: () => {},
    recordFlowRunStart: () => {},
    reconcileInterruptedFlowRuns: () => 0,
    pruneFlowRuns: () => 0,
}));
vi.mock('../../db', () => ({ getAppGrant: () => null, listWorkspaces: () => [] }));
vi.mock('../../apps/bridge', () => ({ dispatchAppCall: () => ({ ok: true }) }));
vi.mock('../../files/watch', () => ({
    onFileWatchEvent: () => {},
    unwatchWorkspace: () => {},
    watchWorkspace: () => {},
}));
vi.mock('../../terminal/process-scheduler', () => ({ setFlowFireHandler: () => {} }));
vi.mock('../../remote', () => ({ broadcastLocal: () => 0 }));

const alerts = vi.hoisted(() => ({ played: [] as string[] }));
vi.mock('../../notify-sound', () => ({
    playAlert: (kind: string) => {
        alerts.played.push(kind);
        return true;
    },
}));

import { runFlowManually } from '../index';

const deps = {} as never;

beforeEach(() => {
    alerts.played.length = 0;
    runner.result = { ok: true };
});

describe('a Flow that finished', () => {
    it('raises flowRun when it ran', async () => {
        await runFlowManually('flow-1', deps);
        expect(alerts.played).toEqual(['flowRun']);
    });

    it('raises FAILURE, not flowRun, when it errored', async () => {
        // "A Flow finished" is not what happened. Announcing a failure with the
        // finish chime tells the listener the opposite of the truth, and the
        // failure is the outcome they most need to hear.
        runner.result = { ok: false, error: 'a step threw' };
        await runFlowManually('flow-1', deps);
        expect(alerts.played).toEqual(['failure']);
    });

    it('raises FAILURE when admission refused the graph', async () => {
        runner.result = { ok: false, refusals: [{ nodeId: 'n1', reason: 'no grant' }] };
        await runFlowManually('flow-1', deps);
        expect(alerts.played).toEqual(['failure']);
    });

    it('raises exactly ONE alert per run', async () => {
        // POSITIVE CONTROL against a wiring that fired on start AND finish: a
        // Flow that runs every minute would then be twice as loud as intended.
        await runFlowManually('flow-1', deps);
        await runFlowManually('flow-2', deps);
        expect(alerts.played).toEqual(['flowRun', 'flowRun']);
    });
});
