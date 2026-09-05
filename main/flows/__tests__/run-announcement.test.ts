/**
 * The runtime says when a body BEGINS, not only how it ended.
 *
 * The header button animates while a Flow is running, and the only honest
 * source for that is the dispatcher itself — it is the one thing that knows a
 * body was entered. Everything else would be a guess dressed as a fact.
 *
 * ## Why a start announcement had to be added at all
 *
 * `onLog` fires once per candidate Flow, at the END, for runs and refusals
 * alike. From logs alone you cannot tell "started and is still going" from
 * "never started": both look like silence. So the interesting property is not
 * that a start is announced — it is that a start is announced for EXACTLY the
 * Flows whose bodies ran, and for none of the ones stopped at a gate.
 *
 * A Flow refused by admission, held by the loop guard, or pointing at a missing
 * recipe must not light the header on its way to being logged. That is the
 * difference between a badge and a badge that lies.
 */

import { describe, expect, it, vi } from 'vitest';
import { createFlowEventRegistry } from '../events';
import { FlowLoopGuard } from '../loop';
import { FlowRuntime, type FlowRunLog, type FlowRunStart } from '../runtime';
import type { Flow, FlowRecipe } from '../types';

function registry() {
    const r = createFlowEventRegistry();
    r.register({
        id: 'demo:happened',
        label: 'Demo',
        props: [{ key: 'note', type: 'string', label: 'Note' }],
    });
    return r;
}

function flow(over: Partial<Flow> = {}): Flow {
    return {
        id: 'w',
        title: 'W',
        purpose: 'Testing',
        scope: { kind: 'system' },
        enabled: true,
        triggers: [{ kind: 'event', event: 'demo:happened' }, { kind: 'manual' }],
        recipe: { kind: 'builtin', recipeId: 'r' },
        ...over,
    };
}

/** A body that runs a task — the one step type an unattended run may execute. */
const taskRecipe = (run: () => Promise<void> = async () => {}): FlowRecipe => ({
    id: 'r',
    title: 'R',
    steps: [{ type: 'task', id: 'go', title: 'Go', run: async () => run() }],
});

/** A body an UNATTENDED run is refused — a form is not a task. */
const formRecipe: FlowRecipe = {
    id: 'r',
    title: 'R',
    steps: [
        {
            type: 'form',
            id: 'ask',
            title: 'Ask',
            fields: [{ key: 'k', label: 'K', type: 'text' }],
        },
    ] as unknown as FlowRecipe['steps'],
};

function harness(opts: { flows?: Flow[]; recipe?: FlowRecipe | null; guard?: FlowLoopGuard }) {
    const logs: FlowRunLog[] = [];
    const starts: FlowRunStart[] = [];
    const runtime = new FlowRuntime({
        registry: registry(),
        guard: opts.guard ?? new FlowLoopGuard(),
        listFlows: () => opts.flows ?? [flow()],
        resolveRecipe: () => opts.recipe ?? null,
        onLog: (l) => void logs.push(l),
        onRunStart: (s) => void starts.push(s),
    });
    return { runtime, logs, starts };
}

const emit = (rt: FlowRuntime) =>
    rt.emit({ event: 'demo:happened', props: {}, source: { kind: 'system' } });

describe('a body that runs announces its start', () => {
    it('announces once, before the body, with the run id the log will carry', async () => {
        const order: string[] = [];
        const h = harness({
            recipe: taskRecipe(async () => void order.push('body')),
        });
        // The announcement has to precede the work, or the header lights up
        // after the thing it is reporting has already finished.
        const runtime = new FlowRuntime({
            registry: registry(),
            guard: new FlowLoopGuard(),
            listFlows: () => [flow()],
            resolveRecipe: () => taskRecipe(async () => void order.push('body')),
            onRunStart: () => void order.push('start'),
            onLog: () => void order.push('log'),
        });

        await emit(runtime);
        expect(order).toEqual(['start', 'body', 'log']);

        await emit(h.runtime);
        expect(h.starts).toHaveLength(1);
        expect(h.starts[0]?.flowId).toBe('w');
        expect(h.starts[0]?.runId).toBe(h.logs[0]?.runId);
        expect(h.starts[0]?.event).toBe('demo:happened');
    });

    it('announces a MANUAL run too, with no event', async () => {
        const h = harness({ recipe: taskRecipe() });

        await h.runtime.runManually('w');

        expect(h.starts).toHaveLength(1);
        expect(h.starts[0]?.event).toBeUndefined();
    });

    it('still announces when the body THROWS, so the finish has a start to close', async () => {
        const h = harness({
            recipe: taskRecipe(async () => {
                throw new Error('nope');
            }),
        });

        await emit(h.runtime);

        expect(h.logs[0]?.outcome).toBe('failed');
        // Without this the header would keep animating a run that already died.
        expect(h.starts.map((s) => s.runId)).toEqual([h.logs[0]?.runId]);
    });

    it('announces once per Flow when several react to the same event', async () => {
        const h = harness({
            flows: [flow({ id: 'a' }), flow({ id: 'b' })],
            recipe: taskRecipe(),
        });

        await emit(h.runtime);

        expect(h.starts.map((s) => s.flowId).sort()).toEqual(['a', 'b']);
    });
});

describe('a body that never ran announces NOTHING', () => {
    it('is silent when the loop guard holds the Flow', async () => {
        const guard = new FlowLoopGuard();
        const h = harness({ recipe: taskRecipe(), guard });

        // Trip the breaker: the guard is what decides, so this drives it through
        // the runtime rather than reaching inside it.
        for (let i = 0; i < 40; i++) await emit(h.runtime);

        const blocked = h.logs.filter((l) => l.outcome === 'blocked');
        expect(blocked.length).toBeGreaterThan(0);
        // POSITIVE CONTROL: starts were announced for the runs that DID happen,
        // so "no start for the blocked ones" is a real claim and not a callback
        // that was never wired.
        expect(h.starts.length).toBeGreaterThan(0);
        expect(h.starts.length).toBe(h.logs.length - blocked.length);
        const startedIds = new Set(h.starts.map((s) => s.runId));
        expect(blocked.some((l) => startedIds.has(l.runId))).toBe(false);
    });

    it('is silent when the recipe is not installed', async () => {
        const h = harness({ recipe: null });

        await emit(h.runtime);

        expect(h.logs[0]?.outcome).toBe('refused');
        expect(h.starts).toEqual([]);
    });

    it('is silent when admission refuses the body for an unattended run', async () => {
        const h = harness({ recipe: formRecipe });

        await emit(h.runtime);

        expect(h.logs[0]?.outcome).toBe('refused');
        expect(h.starts).toEqual([]);
    });

    it('is silent when a manual run is handed off to the wizard', async () => {
        const h = harness({ recipe: formRecipe, flows: [flow()] });

        const log = await h.runtime.runManually('w');

        // `handoff` means THIS process did not execute the body. Announcing a
        // start would make the header report work that is happening somewhere
        // else, or nowhere.
        expect(log.outcome).toBe('handoff');
        expect(h.starts).toEqual([]);
    });

    it('is silent when a disabled Flow is asked to run', async () => {
        const h = harness({ flows: [flow({ enabled: false })], recipe: taskRecipe() });

        await h.runtime.runManually('w');

        expect(h.starts).toEqual([]);
    });
});

describe('the announcement is optional', () => {
    it('a runtime with no onRunStart behaves exactly as before', async () => {
        const logs: FlowRunLog[] = [];
        const ran = vi.fn();
        const runtime = new FlowRuntime({
            registry: registry(),
            guard: new FlowLoopGuard(),
            listFlows: () => [flow()],
            resolveRecipe: () => taskRecipe(async () => void ran()),
            onLog: (l) => void logs.push(l),
        });

        await emit(runtime);

        expect(ran).toHaveBeenCalledTimes(1);
        expect(logs[0]?.outcome).toBe('ran');
    });
});
