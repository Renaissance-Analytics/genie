import { describe, expect, it, vi } from 'vitest';
import { runStoredFlow, type FlowRunnerDeps } from '../runner';
import type { AppGrant } from '../../apps/bridge-decision';
import type { FlowRow } from '../store';

/**
 * Load, judge, then run — and never in a different order.
 *
 * The ordering IS the feature. Admission can judge a whole graph because a graph
 * is inert data, so a flow the app may not run must be refused with NOTHING
 * executed. A runner that started the graph and let the bridge refuse step by
 * step would leave every step before the refused one already done — which for an
 * automation means a half-finished job reported as a permission error.
 *
 * The bridge is still the lock: `buildFlowExecutors` calls it for every step of
 * an admitted graph, because a graph can change between admission and run.
 */

const grant = (over: Partial<AppGrant> = {}): AppGrant => ({
    appId: 'app-1',
    appName: 'Trader',
    workspaceId: 'ws-1',
    scope: 'self',
    capabilities: ['hosting'],
    revoked: false,
    ...over,
});

const flow = (over: Partial<FlowRow> = {}): FlowRow => ({
    id: 'f1',
    appId: 'app-1',
    name: 'Nightly',
    graph: {
        nodes: [
            { id: 't', type: 'trigger', data: { kind: '@particle-academy/manual_trigger' } },
            { id: 'a', type: 'action', data: { kind: 'genie.manageSite', config: {} } },
        ],
        edges: [{ id: 'e', source: 't', target: 'a' }],
    } as never,
    enabled: true,
    createdAt: '',
    updatedAt: '',
    ...over,
});

const deps = (over: Partial<FlowRunnerDeps> = {}): FlowRunnerDeps => ({
    loadFlow: () => flow(),
    loadGrant: () => grant(),
    dispatch: vi.fn(async () => ({ ok: true as const, result: 'ran' })),
    ...over,
});

describe('a flow the app may run', () => {
    it('runs, and reports the capabilities it used', async () => {
        const d = deps();
        const out = await runStoredFlow('f1', d);

        expect(out.ok).toBe(true);
        expect(out.capabilities).toEqual(['hosting']);
        expect(d.dispatch).toHaveBeenCalledTimes(1);
    });
});

describe('a flow the app may NOT run', () => {
    it('is refused with nothing executed at all', async () => {
        const d = deps({ loadGrant: () => grant({ capabilities: [] }) });
        const out = await runStoredFlow('f1', d);

        expect(out.ok).toBe(false);
        expect(out.refusals?.[0]?.nodeId).toBe('a');
        // The whole point: the bridge was never reached, so nothing happened.
        expect(d.dispatch).not.toHaveBeenCalled();
    });

    it('is refused when the app is revoked', async () => {
        const d = deps({ loadGrant: () => grant({ revoked: true }) });
        const out = await runStoredFlow('f1', d);

        expect(out.ok).toBe(false);
        expect(out.error).toContain('revoked');
        expect(d.dispatch).not.toHaveBeenCalled();
    });

    it('is refused when the app has no grant at all', async () => {
        const d = deps({ loadGrant: () => null });

        expect((await runStoredFlow('f1', d)).ok).toBe(false);
        expect(d.dispatch).not.toHaveBeenCalled();
    });
});

describe('a flow that cannot be loaded', () => {
    it('reports a missing flow rather than running an empty graph', async () => {
        const d = deps({ loadFlow: () => null });
        const out = await runStoredFlow('nope', d);

        expect(out.ok).toBe(false);
        expect(out.error).toBeTruthy();
        expect(d.dispatch).not.toHaveBeenCalled();
    });

    it('refuses a flow whose stored graph is corrupt', async () => {
        // `store.getFlow` reads an unparseable graph back as null rather than
        // throwing, so the runner is where that becomes a refusal.
        const d = deps({ loadFlow: () => flow({ graph: null }) });

        expect((await runStoredFlow('f1', d)).ok).toBe(false);
        expect(d.dispatch).not.toHaveBeenCalled();
    });

    it('refuses a disabled flow', async () => {
        // Disabled means disabled however the run was asked for — by schedule, or
        // by hand. Honouring it only in the scheduler would leave a stopped flow
        // runnable from the UI.
        const d = deps({ loadFlow: () => flow({ enabled: false }) });

        expect((await runStoredFlow('f1', d)).ok).toBe(false);
        expect(d.dispatch).not.toHaveBeenCalled();
    });
});

describe('a step that fails once the run is under way', () => {
    it('fails the run and says which step', async () => {
        const d = deps({
            dispatch: vi.fn(async () => ({ ok: false as const, error: 'the site is not there' })),
        });
        const out = await runStoredFlow('f1', d);

        expect(out.ok).toBe(false);
        expect(out.error).toContain('the site is not there');
    });
});

describe('the event feed', () => {
    it('hands every engine event to the listener', async () => {
        const events: string[] = [];
        await runStoredFlow('f1', deps(), (e) => events.push((e as { type: string }).type));

        expect(events).toContain('run-start');
        expect(events).toContain('run-end');
    });

    it('does not emit run events for a flow that was refused before it started', async () => {
        // A refused flow did not run, and a feed showing run-start/run-end for it
        // would say otherwise.
        const events: string[] = [];
        await runStoredFlow(
            'f1',
            deps({ loadGrant: () => grant({ capabilities: [] }) }),
            (e) => events.push((e as { type: string }).type),
        );

        expect(events).toEqual([]);
    });
});
