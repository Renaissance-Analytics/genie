import { describe, expect, it, vi } from 'vitest';
import type { FlowInFlight } from '../../src/main/flow-store.js';
import { edge, kindCase, node, runNow, save, TestClock, trySave, useGenie, type DocEdge, type DocNode, type Genie } from './harness.js';

/**
 * THE LOGIC AND OUTPUT NODES (fancy-flow's own kinds, run by Genie's runner): Branch, Switch, Merge, Transform, Variable,
 * Wait, Log, Output, Note. Each in a flow saved the way the canvas saves it and started by Run now; the EFFECT is what the
 * run recorded — the port that was taken (the other's steps `skipped`), the Log lines, the value an Output kept.
 */

const genie = useGenie();
const manual = node('t', '@particle-academy/manual_trigger');
const fields = (id: string, values: Record<string, string>, x = 200) => node(id, '@particle-academy/transform', { mode: 'fields', fields: Object.entries(values).map(([key, value]) => ({ key, value })) }, x);
const log = (id: string, message: string, x = 600) => node(id, '@particle-academy/log', { level: 'info', message }, x);

/** Save a flow, Run now, and give back the run; `again` re-saves it (an edit on the canvas) and runs it again. */
async function flow(g: Genie, name: string, nodes: DocNode[], edges: DocEdge[]) {
    const id = await save(g, name, nodes, edges);
    return {
        id,
        run: () => runNow(g, id),
        again: async (nextNodes: DocNode[]) => {
            const saved = await trySave(g, name, nextNodes, edges, id);
            expect(saved.ok).toBe(true);
            return runNow(g, id);
        },
    };
}

/** Every in-flight record Genie wrote for a run (what a resume reads, and the canvas's live overlay). */
function inFlightWrites(g: Genie): FlowInFlight[] {
    const writes: FlowInFlight[] = [];
    const real = g.services.flows.markInFlight.bind(g.services.flows);
    vi.spyOn(g.services.flows, 'markInFlight').mockImplementation(async (id, inFlight) => { if (inFlight) writes.push(structuredClone(inFlight)); return real(id, inFlight); });
    return writes;
}

describe('routing', () => {
    kindCase('@particle-academy/branch', 'Branch: a condition that holds goes down `true`; edited so it does not, down `false` — the other port’s step is skipped', genie, async () => {
        const g = genie();
        const nodes = (status: string) => [
            manual,
            fields('x', { status }),
            node('b', '@particle-academy/branch', { match: 'all', conditions: [{ left: '{{ $json.status }}', operator: 'eq', right: 'green' }] }, 400),
            log('yes', 'true: {{ $json.status }}'),
            log('no', 'false: {{ $json.status }}'),
        ];
        const f = await flow(g, 'branch', nodes('green'), [edge('t', 'x'), edge('x', 'b'), edge('b', 'yes', 'true'), edge('b', 'no', 'false')]);
        expect(await f.run()).toMatchObject({ outcome: 'ran', log: ['true: green'], nodes: { b: 'ran', yes: 'ran', no: 'skipped' } });
        expect(await f.again(nodes('red'))).toMatchObject({ outcome: 'ran', log: ['false: red'], nodes: { b: 'ran', yes: 'skipped', no: 'ran' } });
    });

    kindCase('@particle-academy/switch_case', 'Switch: each case goes down its own port, an unmatched value down `default`', genie, async () => {
        const g = genie();
        const nodes = (kind: string) => [
            manual,
            fields('x', { kind }),
            node('s', '@particle-academy/switch_case', { value: '{{ $json.kind }}', cases: { a: 'case_a', b: 'case_b' } }, 400),
            log('A', 'went a'),
            log('B', 'went b'),
            log('D', 'went default: {{ $json.kind }}'),
        ];
        const f = await flow(g, 'switch', nodes('a'), [edge('t', 'x'), edge('x', 's'), edge('s', 'A', 'case_a'), edge('s', 'B', 'case_b'), edge('s', 'D', 'default')]);
        expect(await f.run()).toMatchObject({ log: ['went a'], nodes: { A: 'ran', B: 'skipped', D: 'skipped' } });
        expect(await f.again(nodes('b'))).toMatchObject({ log: ['went b'], nodes: { A: 'skipped', B: 'ran', D: 'skipped' } });
        expect(await f.again(nodes('zebra'))).toMatchObject({ log: ['went default: zebra'], nodes: { A: 'skipped', B: 'skipped', D: 'ran' } });
    });

    kindCase('@particle-academy/merge', 'Merge: two branches meet; the step after it sees both values', genie, async () => {
        const g = genie();
        const f = await flow(g, 'merge', [
            manual,
            fields('x', { left: 'L' }),
            node('y', '@particle-academy/transform', { mode: 'fields', fields: [{ key: 'right', value: 'R' }] }, 200, 120),
            node('m', '@particle-academy/merge', { mode: 'merge' }, 400),
            log('l', '{{ $json.left }}+{{ $json.right }}'),
        ], [edge('t', 'x'), edge('t', 'y'), edge('x', 'm', undefined, 'a'), edge('y', 'm', undefined, 'b'), edge('m', 'l')]);
        expect(await f.run()).toMatchObject({ outcome: 'ran', log: ['L+R'], nodes: { x: 'ran', y: 'ran', m: 'ran', l: 'ran' } });
    });
});

describe('data', () => {
    kindCase('@particle-academy/transform', 'Transform: field by field from what arrived, and one expression', genie, async () => {
        const g = genie();
        const f = await flow(g, 'transform', [
            manual,
            fields('x', { fixed: 'shipped', when: '{{ $json.firedAt }}' }),
            node('e', '@particle-academy/transform', { mode: 'expression', expression: '{{ $json.fixed }}' }, 400),
            log('l', '{{ $json }}'),
        ], [edge('t', 'x'), edge('x', 'e'), edge('e', 'l')]);
        expect(await f.run()).toMatchObject({ outcome: 'ran', log: ['shipped'], nodes: { x: 'ran', e: 'ran' } });
    });

    kindCase('@particle-academy/variable', 'Variable: its value, evaluated from what arrived, is what the next step gets', genie, async () => {
        const g = genie();
        const f = await flow(g, 'variable', [
            manual,
            fields('x', { name: 'atlas' }),
            node('v', '@particle-academy/variable', { name: 'greeting', value: '{{ $json.name }}' }, 400),
            log('l', 'hello {{ $json }}'),
        ], [edge('t', 'x'), edge('x', 'v'), edge('v', 'l')]);
        expect(await f.run()).toMatchObject({ outcome: 'ran', log: ['hello atlas'], nodes: { v: 'ran' } });
    });
});

describe('waiting', () => {
    kindCase('@particle-academy/wait', 'Wait: the next step runs only after the duration — NEVER sooner, on the runner’s own clock (genie#1260) — and gets what arrived', genie, async () => {
        const g = genie();
        // The wait is timed from the moment its step starts to the moment it is recorded done, on Date.now — the clock the
        // runner and the scheduler read. Just before the step starts, the run's in-flight write does synchronous work, as a
        // slow machine's flows.json write does: a timer counted from a moment before that work ends early (genie#1260).
        let started = 0;
        let done = 0;
        const real = g.services.flows.markInFlight.bind(g.services.flows);
        vi.spyOn(g.services.flows, 'markInFlight').mockImplementation(async (id, inFlight) => {
            if (inFlight?.nodes.w === 'running' && started === 0) {
                const until = Date.now() + 40;
                while (Date.now() < until) { /* the synchronous part of a slow write */ }
                started = Date.now();
            }
            if (inFlight?.nodes.w === 'ran' && done === 0) done = Date.now();
            return real(id, inFlight);
        });
        const f = await flow(g, 'wait', [
            manual,
            fields('x', { parcel: 'box' }),
            node('w', '@particle-academy/wait', { mode: 'duration', duration: '100ms' }, 400),
            log('l', 'after the wait: {{ $json.input.parcel }}'),
        ], [edge('t', 'x'), edge('x', 'w'), edge('w', 'l')]);
        const run = await f.run();
        expect(run).toMatchObject({ outcome: 'ran', log: ['after the wait: box'], nodes: { w: 'ran', l: 'ran' } });
        expect(started).toBeGreaterThan(0);
        expect(done - started).toBeGreaterThanOrEqual(100);
    });
});

describe('waiting, on the runner’s clock (genie#1260)', () => {
    const clock = new TestClock();
    const onClock = useGenie(() => ({ clock }));

    it('a Wait is over only when the clock the runner reads says its duration has passed — even when that clock is set back meanwhile', async () => {
        const g = onClock();
        // genie#1260: on omarchy-test a 50 ms Wait was measured on Date.now as 44 ms. A synchronous stall before the timer
        // (the case above) does not make it early; the wall clock being corrected under it does — a VM restored from a
        // snapshot has its clock set right by time sync while it runs. Here the runner's clock is set back 200 ms, once,
        // while the step waits: the step must still not end before 100 ms have passed ON THAT CLOCK.
        let started = 0;
        let done = 0;
        const real = g.services.flows.markInFlight.bind(g.services.flows);
        vi.spyOn(g.services.flows, 'markInFlight').mockImplementation(async (id, inFlight) => {
            if (inFlight?.nodes.w === 'running' && started === 0) {
                started = clock.now();
                setTimeout(() => clock.set(clock.now() - 200), 20);
            }
            if (inFlight?.nodes.w === 'ran' && done === 0) done = clock.now();
            return real(id, inFlight);
        });
        const f = await flow(g, 'wait', [manual, node('w', '@particle-academy/wait', { mode: 'duration', duration: '100ms' }, 300), log('l', 'after')], [edge('t', 'w'), edge('w', 'l')]);
        expect(await f.run()).toMatchObject({ outcome: 'ran', log: ['after'] });
        expect(started).toBeGreaterThan(0);
        expect(done - started).toBeGreaterThanOrEqual(100);
    });
});

describe('output', () => {
    kindCase('@particle-academy/log', 'Log: each line is kept with the run, in order, its template resolved', genie, async () => {
        const g = genie();
        const f = await flow(g, 'log', [
            manual,
            fields('x', { count: '3' }),
            node('l1', '@particle-academy/log', { level: 'info', message: 'found {{ $json.count }} reports' }, 400),
            node('l2', '@particle-academy/log', { level: 'warn', message: 'review them' }, 400, 120),
        ], [edge('t', 'x'), edge('x', 'l1'), edge('x', 'l2')]);
        const run = await f.run();
        expect(run.outcome).toBe('ran');
        expect([...(run.log ?? [])].sort()).toEqual(['found 3 reports', 'review them']);
    });

    kindCase('@particle-academy/output', 'Output: the flow’s result is the value that reached it, kept with the run', genie, async () => {
        const g = genie();
        const writes = inFlightWrites(g);
        const f = await flow(g, 'output', [manual, fields('x', { answer: '42' }), node('o', '@particle-academy/output', {}, 400)], [edge('t', 'x'), edge('x', 'o')]);
        expect(await f.run()).toMatchObject({ outcome: 'ran', nodes: { o: 'ran' } });
        expect(writes.at(-1)!.outputs).toMatchObject({ o: { answer: '42' } });
    });

    kindCase('@particle-academy/note', 'Note: an annotation on the canvas is saved with the flow and walked past by the run — never a step', genie, async () => {
        const g = genie();
        const f = await flow(g, 'noted', [manual, node('n', '@particle-academy/note', { text: 'runs every night' }, 0, 200), log('l', 'ran')], [edge('t', 'l')]);
        const run = await f.run();
        expect(run).toMatchObject({ outcome: 'ran', log: ['ran'] });
        expect(run.nodes).not.toHaveProperty('n');
        expect(JSON.stringify(g.services.flows.get(f.id)!.document)).toContain('runs every night');
    });
});
