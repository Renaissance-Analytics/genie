import { describe, expect, it, vi } from 'vitest';
import { runStoredFlow, type FlowRunnerDeps } from '../runner';
import type { AppGrant } from '../../apps/bridge-decision';
import type { FlowRow } from '../store';
import { PAUSES_WITHOUT_RESUME } from '../refusals';

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

/**
 * A flow, shaped the way the canvas shapes one.
 *
 * `type` is the KIND id, not a coarse kit — that is what `<FlowEditor>` writes,
 * and hand-writing the old shape here is precisely how the executor-resolution
 * bug survived a green suite.
 */
const flow = (over: Partial<FlowRow> = {}): FlowRow => ({
    id: 'f1',
    appId: 'app-1',
    title: 'Nightly',
    purpose: 'Automation',
    scope: { kind: 'gapp', appId: 'app-1' },
    graph: {
        nodes: [
            {
                id: 't',
                type: '@particle-academy/manual_trigger',
                data: { kind: '@particle-academy/manual_trigger', config: {} },
            },
            {
                id: 'a',
                type: '@genie/manageSite',
                data: { kind: '@genie/manageSite', config: {} },
            },
        ],
        edges: [{ id: 'e', source: 't', target: 'a' }],
    } as never,
    enabled: true,
    createdAt: '',
    updatedAt: '',
    ...over,
});

/** Every run here is a hand-pressed Run, unless a test says otherwise. */
const MANUAL = { trigger: 'manual' } as const;

const deps = (over: Partial<FlowRunnerDeps> = {}): FlowRunnerDeps => ({
    loadFlow: () => flow(),
    loadGrant: () => grant(),
    dispatch: vi.fn(async () => ({ ok: true as const, result: 'ran' })),
    ...over,
});

describe('a flow the app may run', () => {
    it('runs, and reports the capabilities it used', async () => {
        const d = deps();
        const out = await runStoredFlow('f1', MANUAL, d);

        expect(out.ok).toBe(true);
        expect(out.capabilities).toEqual(['hosting']);
        expect(d.dispatch).toHaveBeenCalledTimes(1);
    });
});

describe('a flow the app may NOT run', () => {
    it('is refused with nothing executed at all', async () => {
        const d = deps({ loadGrant: () => grant({ capabilities: [] }) });
        const out = await runStoredFlow('f1', MANUAL, d);

        expect(out.ok).toBe(false);
        expect(out.refusals?.[0]?.nodeId).toBe('a');
        // The whole point: the bridge was never reached, so nothing happened.
        expect(d.dispatch).not.toHaveBeenCalled();
    });

    it('is refused when the app is revoked', async () => {
        const d = deps({ loadGrant: () => grant({ revoked: true }) });
        const out = await runStoredFlow('f1', MANUAL, d);

        expect(out.ok).toBe(false);
        expect(out.error).toContain('revoked');
        expect(d.dispatch).not.toHaveBeenCalled();
    });

    it('is refused when the app has no grant at all', async () => {
        const d = deps({ loadGrant: () => null });

        expect((await runStoredFlow('f1', MANUAL, d)).ok).toBe(false);
        expect(d.dispatch).not.toHaveBeenCalled();
    });
});

describe('a flow that cannot be loaded', () => {
    it('reports a missing flow rather than running an empty graph', async () => {
        const d = deps({ loadFlow: () => null });
        const out = await runStoredFlow('nope', MANUAL, d);

        expect(out.ok).toBe(false);
        expect(out.error).toBeTruthy();
        expect(d.dispatch).not.toHaveBeenCalled();
    });

    it('refuses a flow whose stored graph is corrupt', async () => {
        // `store.getFlow` reads an unparseable graph back as null rather than
        // throwing, so the runner is where that becomes a refusal.
        const d = deps({ loadFlow: () => flow({ graph: null }) });

        expect((await runStoredFlow('f1', MANUAL, d)).ok).toBe(false);
        expect(d.dispatch).not.toHaveBeenCalled();
    });

    it('refuses a disabled flow on a SCHEDULE or an event', async () => {
        // ★ This changed, so read the reasoning rather than trusting either half
        // from memory. It used to be "disabled means disabled however the run was
        // asked for", on the argument that honouring it only in the scheduler
        // would leave a stopped flow runnable from the UI.
        //
        // What `enabled` actually governs is UNATTENDED firing — that is what
        // arming a flow consents to, and what turning it off withdraws. A manual
        // run is attended by definition: a person or an agent asked for it, now.
        //
        // The old rule also had a cost nobody had noticed: a flow is BORN
        // disarmed, so refusing manual runs meant you could not try one without
        // first arming it — which pushed people to grant standing unattended
        // permission in order to test something once. That is worse security,
        // not better.
        const d = deps({ loadFlow: () => flow({ enabled: false }) });

        expect((await runStoredFlow('f1', { trigger: 'schedule' }, d)).ok).toBe(false);
        expect((await runStoredFlow('f1', { trigger: 'event' }, d)).ok).toBe(false);
        expect(d.dispatch).not.toHaveBeenCalled();
    });

    it('still runs a disabled flow BY HAND, so one can be tested before arming', async () => {
        const d = deps({
            loadFlow: () => flow({ enabled: false }),
        });

        expect((await runStoredFlow('f1', MANUAL, d)).ok).toBe(true);
        expect(d.dispatch).toHaveBeenCalledTimes(1);
    });
});

describe('a step that fails once the run is under way', () => {
    it('fails the run and says which step', async () => {
        const d = deps({
            dispatch: vi.fn(async () => ({ ok: false as const, error: 'the site is not there' })),
        });
        const out = await runStoredFlow('f1', MANUAL, d);

        expect(out.ok).toBe(false);
        expect(out.error).toContain('the site is not there');
    });
});

describe('the event feed', () => {
    it('hands every engine event to the listener', async () => {
        const events: string[] = [];
        await runStoredFlow('f1', MANUAL, deps(), (e) => events.push((e as { type: string }).type));

        expect(events).toContain('run-start');
        expect(events).toContain('run-end');
    });

    it('does not emit run events for a flow that was refused before it started', async () => {
        // A refused flow did not run, and a feed showing run-start/run-end for it
        // would say otherwise.
        const events: string[] = [];
        await runStoredFlow(
            'f1',
            MANUAL,
            deps({ loadGrant: () => grant({ capabilities: [] }) }),
            (e) => events.push((e as { type: string }).type),
        );

        expect(events).toEqual([]);
    });
});

/**
 * The third door: a stored flow that already contains a pause step.
 *
 * The palette stopped offering these when fancy-flow 0.66.0's `kindFilter`
 * landed, but a flow written before that, imported, or authored by an agent is
 * still sitting in the database — and this is where it would finally run. A
 * refusal at admission and at save that let the RUN through would be the worst
 * of the three to lose: it is the one where the hang actually happens.
 */
describe('a stored flow with a step that would park a run', () => {
    const withPause = (kind: string) =>
        flow({
            graph: {
                nodes: [
                    {
                        id: 't',
                        type: '@particle-academy/manual_trigger',
                        data: { kind: '@particle-academy/manual_trigger', config: {} },
                    },
                    { id: 'h', type: kind, data: { kind, config: {} } },
                ],
                edges: [{ id: 'e', source: 't', target: 'h' }],
            } as never,
        });

    it.each([...PAUSES_WITHOUT_RESUME])('is refused before anything runs (%s)', async (kind) => {
        const d = deps({ loadFlow: () => withPause(kind) });
        const out = await runStoredFlow('f1', MANUAL, d);

        expect(out.ok).toBe(false);
        expect(out.refusals?.[0]?.nodeId).toBe('h');
        expect(out.refusals?.[0]?.reason).toMatch(/cannot resume a paused flow/);
        // The point: it never started, so there is no half-done automation and
        // nothing waiting on an answer that will never come.
        expect(d.dispatch).not.toHaveBeenCalled();
    });

    it('CONTROL: the same runner still runs the flow beside it', async () => {
        // Without this, a runner that refused everything would pass the above.
        expect((await runStoredFlow('f1', MANUAL, deps())).ok).toBe(true);
    });
});
