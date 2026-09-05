import { describe, expect, it, vi } from 'vitest';
import { listNodeKinds, runFlow } from '@particle-academy/fancy-flow/engine';
import { genieNodeDefinitions, registerGenieKinds } from '../kinds';
import { newFlowEdge, newFlowNode, starterFlowGraph } from '../graph';
import { buildFlowExecutors, type FlowDispatch } from '../executors';

/**
 * Can Genie run the graph a person actually drew?
 *
 * Every other test in this directory hand-writes its nodes, and every one of
 * them hand-writes the SAME shape the starter graph used — a coarse
 * `type: 'action'` that `<FlowEditor>` has not produced since v0.48. So the
 * suite was green while every node an author dragged onto the canvas aborted
 * the run with "No executor registered for kind=@particle-academy/…".
 *
 * A test that builds its own input in a shape the product cannot produce is not
 * testing the product. This file exists to close that specific hole, and it does
 * it structurally rather than by remembering: nodes come from {@link newFlowNode},
 * which is the one function Genie uses to make a node anywhere — starter graphs,
 * templates, the MCP authoring tool — and which mirrors the editor's `addNode`.
 * If that mirror ever drifts, this goes red before a user finds out.
 *
 * It also runs the REAL `runFlow` rather than reaching into the registry by key.
 * Executor resolution is the thing that was broken, and a test that calls
 * `executors[node.type]` itself has assumed away the bug it is meant to catch.
 */

const dispatch: FlowDispatch = vi.fn(async () => ({ ok: true as const, result: null }));

/** True when the run died because nothing claimed the node — the bug. */
function unresolved(error: string | undefined): boolean {
    return typeof error === 'string' && error.includes('No executor registered');
}

async function runSingle(kindName: string) {
    const node = newFlowNode(kindName, { x: 0, y: 0 }, 'n1');
    expect(node, `no registered kind called ${kindName}`).not.toBeNull();
    return runFlow(
        { nodes: [node!], edges: [] } as never,
        buildFlowExecutors('com.example.app', dispatch) as never,
        () => {},
        {},
    );
}

describe('a node built the way the editor builds one', () => {
    it('carries the KIND id as its type, exactly as `addNode` writes it', () => {
        const node = newFlowNode('@particle-academy/branch');

        // The whole bug in one assertion: `type` is the kind, not a coarse kit.
        expect(node?.type).toBe('@particle-academy/branch');
        expect(node?.data.kind).toBe('@particle-academy/branch');
    });

    it('resolves an alias to the canonical kind id, never storing the alias', () => {
        // A stored graph outlives the spelling it was written with.
        expect(newFlowNode('manual_trigger')?.type).toBe('@particle-academy/manual_trigger');
    });

    it('is null for a kind nothing registered, rather than an unrunnable node', () => {
        expect(newFlowNode('@nobody/invented_this')).toBeNull();
    });
});

/**
 * Every kind that can appear on a Genie canvas — fancy-flow's builtins, and
 * Genie's own steps.
 *
 * Named EXPLICITLY rather than taken from `listNodeKinds()`, and that is not
 * pedantry. The registry is a process global, and vitest shares a worker across
 * files: a run of this directory once enumerated fifteen more kinds than a run
 * of this file alone, because another test file had registered them first. A
 * suite whose CASE LIST depends on execution order is one that can silently stop
 * covering something and still report green.
 *
 * `registerGenieKinds()` is called here so this file's list is the same whether
 * or not anything else ran first.
 */
registerGenieKinds();

const AUTHORABLE_KINDS: string[] = [
    ...listNodeKinds()
        .map((k) => k.name)
        .filter((name) => name.startsWith('@particle-academy/')),
    ...genieNodeDefinitions().map((d) => d.name),
];

describe('every kind the palette can offer', () => {
    /**
     * The completeness check. A kind that is on the canvas and has no executor
     * is a step a user can draw and Genie cannot run — and the failure lands at
     * run time, which for a scheduled flow means 3am.
     *
     * "Has an executor" is not "does something": Genie deliberately REFUSES
     * `api_request` and friends. A refusal is a decision and passes; silence is
     * the bug.
     */
    it('covers the whole builtin kit and every Genie step', () => {
        // A positive control. "Every kind resolves" passes vacuously over an
        // empty list, and an empty list is exactly what a registry that failed
        // to load would produce.
        expect(AUTHORABLE_KINDS.length).toBeGreaterThanOrEqual(27 + genieNodeDefinitions().length);
    });

    it.each(AUTHORABLE_KINDS.map((name) => [name] as const))(
        '%s resolves to an executor',
        async (kindName) => {
            const result = await runSingle(kindName);

            expect(
                unresolved(result.error),
                `${kindName} reached no executor — a user can draw it and Genie cannot run it`,
            ).toBe(false);
        },
    );
});

describe('a two-node graph, wired the way the canvas wires one', () => {
    it('runs the trigger into the next step instead of stopping at node one', async () => {
        const trigger = newFlowNode('@particle-academy/manual_trigger', { x: 0, y: 0 }, 't')!;
        const log = newFlowNode('@particle-academy/log', { x: 0, y: 120 }, 'l')!;

        const result = await runFlow(
            { nodes: [trigger, log], edges: [newFlowEdge('t', 'l')] } as never,
            buildFlowExecutors('com.example.app', dispatch) as never,
            () => {},
            {},
        );

        expect(unresolved(result.error)).toBe(false);
        expect(result.ok, result.error).toBe(true);
    });
});

describe('the graph a new flow starts as', () => {
    it('is built the same way as every other graph, not hand-written', async () => {
        const graph = starterFlowGraph();

        // The starter used to be a literal with a COARSE `type: 'trigger'` — the
        // one node shape Genie's old executors matched, and the reason the suite
        // never noticed that nothing else did.
        for (const node of graph.nodes) {
            expect(node.type).toBe(node.data.kind);
        }

        const result = await runFlow(
            graph as never,
            buildFlowExecutors('com.example.app', dispatch) as never,
            () => {},
            {},
        );
        expect(unresolved(result.error)).toBe(false);
        expect(result.ok, result.error).toBe(true);
    });

    it('has a trigger, because an empty graph is refused as a failed load', () => {
        // `decideFlowAdmission` treats an empty graph as unrunnable — it is
        // nearly always a bad edit — so a new flow must not open already
        // complaining.
        expect(starterFlowGraph().nodes.length).toBeGreaterThan(0);
    });
});
