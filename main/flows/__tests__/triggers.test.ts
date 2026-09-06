import { describe, expect, it } from 'vitest';
import { armableSchedules, declaredTriggers } from '../triggers';
import type { FlowGraphLike } from '../admission';

/**
 * What starts a flow — read off the graph, not configured beside it.
 *
 * The owner's constraint, verbatim: *"Ops running should not be tied to an agent
 * request unless it's a manual trigger… if any time based triggers exist, a cron
 * checker should auto be started."*
 *
 * So a schedule is not a favour someone does a flow later. It is a property OF
 * the flow, declared on the canvas, and Genie's job is to notice and arm it. That
 * makes this module the thing that decides whether Genie has any scheduling to do
 * at all — which is why it is pure and tested directly.
 *
 * Genie contributes WHAT to run. `manageProcess`'s host scheduler stays the only
 * cron in Genie; there is deliberately no second one here.
 */

const trigger = (id: string, kind: string, config?: Record<string, unknown>): FlowGraphLike['nodes'] extends readonly (infer N)[] ? N : never =>
    ({ id, type: 'trigger', data: { kind, label: id, ...(config ? { config } : {}) } }) as never;

const graph = (...nodes: unknown[]): FlowGraphLike => ({ nodes: nodes as never, edges: [] });

describe('reading declared triggers', () => {
    it('finds a manual trigger', () => {
        const t = declaredTriggers(graph(trigger('t', '@particle-academy/manual_trigger')));

        expect(t).toEqual([{ nodeId: 't', kind: 'manual' }]);
    });

    it('finds a schedule trigger and carries its cron', () => {
        const t = declaredTriggers(
            graph(trigger('t', '@particle-academy/schedule_trigger', { cron: '0 3 * * *' })),
        );

        expect(t).toEqual([{ nodeId: 't', kind: 'schedule', cron: '0 3 * * *' }]);
    });

    it('accepts the kind ALIASES fancy-flow publishes', () => {
        // The registry declares `schedule_trigger` and `@fancy/schedule_trigger`
        // as aliases of the namespaced id. A graph saved by an older editor, or
        // written by hand, uses them — and would otherwise silently declare no
        // trigger at all, which is the worst possible failure for a schedule.
        for (const alias of ['schedule_trigger', '@fancy/schedule_trigger']) {
            expect(declaredTriggers(graph(trigger('t', alias, { cron: '* * * * *' })))).toEqual([
                { nodeId: 't', kind: 'schedule', cron: '* * * * *' },
            ]);
        }
    });

    it('finds several triggers on one graph', () => {
        const t = declaredTriggers(
            graph(
                trigger('m', '@particle-academy/manual_trigger'),
                trigger('s', '@particle-academy/schedule_trigger', { cron: '*/15 * * * *' }),
            ),
        );

        expect(t.map((x) => x.kind)).toEqual(['manual', 'schedule']);
    });

    it('ignores nodes that are not triggers', () => {
        expect(declaredTriggers(graph(trigger('a', 'genie.manageSite')))).toEqual([]);
        expect(declaredTriggers(graph(trigger('b', '@particle-academy/branch')))).toEqual([]);
    });

    it('survives a graph that is not a graph', () => {
        for (const junk of [null, undefined, 'x', 7, {}, { nodes: 'no' }] as unknown[]) {
            expect(() => declaredTriggers(junk as FlowGraphLike)).not.toThrow();
            expect(declaredTriggers(junk as FlowGraphLike)).toEqual([]);
        }
    });
});

describe('a webhook trigger, which Genie cannot arm yet', () => {
    it('is reported, and reported as unsupported', () => {
        // Silently dropping it would leave an author with a flow that looks armed
        // and never fires. Naming it as unsupported is the honest answer until
        // Genie has somewhere for an inbound request to land.
        const t = declaredTriggers(
            graph(trigger('w', '@particle-academy/webhook_trigger', { path: '/hook' })),
        );

        expect(t).toHaveLength(1);
        expect(t[0]!.kind).toBe('webhook');
        expect(t[0]!.unsupported).toBeTruthy();
    });
});

describe('which schedules Genie will actually arm', () => {
    it('arms a valid cron', () => {
        const s = armableSchedules(
            graph(trigger('t', '@particle-academy/schedule_trigger', { cron: '0 9 * * 1-5' })),
        );

        expect(s).toEqual([{ nodeId: 't', cron: '0 9 * * 1-5' }]);
    });

    it('refuses to arm a cron the host scheduler cannot parse', () => {
        // Reusing `isValidCron` matters: a flow must not be armable on an
        // expression `manageProcess` would reject, or the two would disagree
        // about what "every morning" means.
        for (const bad of ['', '   ', 'daily', '0 3 * *', '99 * * * *', '* * * * * *']) {
            const s = armableSchedules(
                graph(trigger('t', '@particle-academy/schedule_trigger', { cron: bad })),
            );
            expect(s, `cron ${JSON.stringify(bad)} must not arm`).toEqual([]);
        }
    });

    it('refuses to arm a schedule trigger with no cron at all', () => {
        expect(armableSchedules(graph(trigger('t', '@particle-academy/schedule_trigger')))).toEqual(
            [],
        );
    });

    it('refuses a cron that is not a string', () => {
        const s = armableSchedules(
            graph(trigger('t', '@particle-academy/schedule_trigger', { cron: ['0 3 * * *'] })),
        );

        expect(s).toEqual([]);
    });

    it('never arms a manual trigger', () => {
        // The one trigger that IS tied to a request, by the owner's rule.
        expect(armableSchedules(graph(trigger('m', '@particle-academy/manual_trigger')))).toEqual(
            [],
        );
    });

    it('arms the valid schedules on a graph that also has an invalid one', () => {
        const s = armableSchedules(
            graph(
                trigger('good', '@particle-academy/schedule_trigger', { cron: '0 3 * * *' }),
                trigger('bad', '@particle-academy/schedule_trigger', { cron: 'nope' }),
            ),
        );

        expect(s).toEqual([{ nodeId: 'good', cron: '0 3 * * *' }]);
    });
});
