/**
 * The dispatcher's ordering, and its honesty.
 *
 * Two things are being pinned down here.
 *
 * The ORDERING: attribute → match → loop-admit → resolve → admit → run. Each
 * stage can only stop the chain, so there is no route from an event to a side
 * effect that skips a gate. The tests assert that a stage which refuses means
 * NOTHING RAN, not that a later stage cleaned up after it.
 *
 * The HONESTY: a Flow that silently does not fire is the hardest failure in an
 * automation system to debug — "it just doesn't work", with no thread to pull.
 * So every outcome is recorded with a reason, including the boring ones, and a
 * body this process did not execute is never reported as having run.
 */

import { describe, expect, it } from 'vitest';
import { createFlowEventRegistry } from '../events';
import { FlowLoopGuard } from '../loop';
import { FlowRuntime, type FlowRunLog } from '../runtime';
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

function harness(opts: {
    flows?: Flow[];
    recipe?: FlowRecipe | null;
    guard?: FlowLoopGuard;
}) {
    const logs: FlowRunLog[] = [];
    const runtime = new FlowRuntime({
        registry: registry(),
        guard: opts.guard ?? new FlowLoopGuard(),
        listFlows: () => opts.flows ?? [flow()],
        resolveRecipe: () => opts.recipe ?? null,
        onLog: (l) => void logs.push(l),
    });
    return { runtime, logs };
}

const ranRecipe = (sink: string[]): FlowRecipe => ({
    id: 'r',
    title: 'R',
    steps: [
        {
            type: 'task',
            id: 'go',
            title: 'Go',
            run: async (ctx) => void sink.push(String(ctx.get('note') ?? 'no-note')),
        },
    ],
});

describe('a run has the event props and the Flow args in its context', () => {
    it('seeds args first and lets the event props win', async () => {
        const seen: string[] = [];
        const h = harness({
            flows: [flow({ recipe: { kind: 'builtin', recipeId: 'r', args: { note: 'default' } } })],
            recipe: ranRecipe(seen),
        });

        await h.runtime.runManually('w');
        expect(seen).toEqual(['default']);

        await h.runtime.emit({
            event: 'demo:happened',
            props: { note: 'from-the-event' },
            source: { kind: 'system' },
        });
        // The prop describes THIS occurrence and must beat standing config.
        expect(seen).toEqual(['default', 'from-the-event']);
    });
});

describe('refusals stop everything, and say why', () => {
    it('refuses a body that is not installed', async () => {
        const h = harness({ recipe: null });
        const [log] = await h.runtime.emit({
            event: 'demo:happened',
            props: {},
            source: { kind: 'system' },
        });
        expect(log.outcome).toBe('refused');
        expect(log.reason).toContain('not installed');
    });

    it('refuses an unattended body with a terminal step BEFORE running its safe steps', async () => {
        const sink: string[] = [];
        const recipe: FlowRecipe = {
            id: 'r',
            title: 'R',
            steps: [
                { type: 'task', id: 'safe', title: 'Safe', run: async () => void sink.push('ran') },
                { type: 'terminal', id: 'sh', title: 'Shell', command: 'rm' },
            ],
        };
        const h = harness({ recipe });
        const [log] = await h.runtime.emit({
            event: 'demo:happened',
            props: {},
            source: { kind: 'system' },
        });
        expect(log.outcome).toBe('refused');
        expect(log.refusals?.map((r) => r.stepId)).toEqual(['sh']);
        // The point of judging up front: the safe step did NOT run first.
        expect(sink).toEqual([]);
    });

    it('records a blocked run when the loop guard holds it, without resolving a body', async () => {
        let resolved = 0;
        const logs: FlowRunLog[] = [];
        const runtime = new FlowRuntime({
            registry: registry(),
            guard: new FlowLoopGuard(),
            listFlows: () => [flow()],
            resolveRecipe: () => {
                resolved++;
                return ranRecipe([]);
            },
            onLog: (l) => void logs.push(l),
        });

        await runtime.emit({
            event: 'demo:happened',
            props: {},
            source: { kind: 'flow', flowId: 'w', runId: 'r1', depth: 0 },
        });
        expect(logs[0].outcome).toBe('blocked');
        expect(logs[0].reason).toContain('caused this event itself');
        expect(resolved, 'a blocked run never even looks up its body').toBe(0);
    });

    it('reports a failing step as failed, naming the step', async () => {
        const recipe: FlowRecipe = {
            id: 'r',
            title: 'R',
            steps: [
                {
                    type: 'task',
                    id: 'boom',
                    title: 'Boom',
                    run: async () => {
                        throw new Error('disk full');
                    },
                },
            ],
        };
        const h = harness({ recipe });
        const [log] = await h.runtime.emit({
            event: 'demo:happened',
            props: {},
            source: { kind: 'system' },
        });
        expect(log.outcome).toBe('failed');
        expect(log.reason).toContain('boom');
        expect(log.reason).toContain('disk full');
    });
});

describe('runManually', () => {
    it('runs a task-only body and reports it ran', async () => {
        const sink: string[] = [];
        const h = harness({ recipe: ranRecipe(sink) });
        const log = await h.runtime.runManually('w');
        expect(log.outcome).toBe('ran');
        expect(sink).toHaveLength(1);
    });

    it('hands a body with UI steps to the wizard rather than claiming it ran', async () => {
        // The alternative would be the runtime lying about the one thing it is
        // for: main cannot render a form, and reporting `ran` for a body this
        // process never executed is the worst available answer.
        const recipe: FlowRecipe = {
            id: 'r',
            title: 'R',
            steps: [{ type: 'form', id: 'ask', title: 'Ask', fields: [] }],
        };
        const h = harness({ recipe });
        const log = await h.runtime.runManually('w');
        expect(log.outcome).toBe('handoff');
    });

    it('refuses a Flow with no manual trigger, a disabled one, and one that does not exist', async () => {
        const h = harness({
            flows: [
                flow({ id: 'no-manual', triggers: [{ kind: 'event', event: 'demo:happened' }] }),
                flow({ id: 'off', enabled: false }),
            ],
            recipe: ranRecipe([]),
        });
        expect((await h.runtime.runManually('no-manual')).outcome).toBe('refused');
        expect((await h.runtime.runManually('off')).outcome).toBe('refused');
        expect((await h.runtime.runManually('ghost')).outcome).toBe('refused');
    });
});

describe('a Flow that triggers another Flow', () => {
    /** `a` announces something; `b` reacts to the announcement. */
    function chain(maxDepth: number) {
        const reached: number[] = [];
        const guard = new FlowLoopGuard({ maxDepth });
        const announce: FlowRecipe = {
            id: 'announce',
            title: 'Announce',
            steps: [
                {
                    type: 'task',
                    id: 'say',
                    title: 'Say',
                    run: async (ctx) => {
                        await ctx.emit({ event: 'demo:happened', props: {} });
                    },
                },
            ],
        };
        const record: FlowRecipe = {
            id: 'record',
            title: 'Record',
            steps: [
                {
                    type: 'task',
                    id: 'note',
                    title: 'Note',
                    run: async (ctx) => {
                        const source = ctx.event?.source;
                        reached.push(source?.kind === 'flow' ? source.depth : 0);
                    },
                },
            ],
        };

        const flows = [
            flow({ id: 'a', recipe: { kind: 'builtin', recipeId: 'announce' } }),
            flow({ id: 'b', recipe: { kind: 'builtin', recipeId: 'record' } }),
        ];
        const runtime = new FlowRuntime({
            registry: registry(),
            guard,
            listFlows: () => flows,
            resolveRecipe: (ref) => (ref.recipeId === 'announce' ? announce : record),
        });
        return { runtime, reached };
    }

    it('attributes the emitted event to the run that caused it, one step deeper', async () => {
        const { runtime, reached } = chain(3);
        await runtime.runManually('a');
        // A manual run is depth 0, so what it emits arrives at depth 1.
        expect(reached).toEqual([1]);
    });

    it('does not let a Flow trigger itself through its own emission', async () => {
        const emitted: string[] = [];
        const guard = new FlowLoopGuard();
        const selfAnnouncing: FlowRecipe = {
            id: 'r',
            title: 'R',
            steps: [
                {
                    type: 'task',
                    id: 'say',
                    title: 'Say',
                    run: async (ctx) => {
                        emitted.push(ctx.runId);
                        await ctx.emit({ event: 'demo:happened', props: {} });
                    },
                },
            ],
        };
        const runtime = new FlowRuntime({
            registry: registry(),
            guard,
            listFlows: () => [flow()],
            resolveRecipe: () => selfAnnouncing,
        });

        await runtime.runManually('w');
        // Ran once. Its own announcement did not start it again.
        expect(emitted).toHaveLength(1);
    });
});

describe('two Flows on one event', () => {
    it('both run, and each is logged', async () => {
        const sink: string[] = [];
        const h = harness({
            flows: [flow({ id: 'a' }), flow({ id: 'b' })],
            recipe: ranRecipe(sink),
        });
        const logs = await h.runtime.emit({
            event: 'demo:happened',
            props: {},
            source: { kind: 'system' },
        });
        expect(logs.map((l) => l.flowId).sort()).toEqual(['a', 'b']);
        expect(sink).toHaveLength(2);
    });
});
