import { describe, expect, it, vi } from 'vitest';
import { runFlow } from '@particle-academy/fancy-flow/engine';
import { buildFlowExecutors, type FlowDispatch } from '../executors';
import { newFlowNode } from '../graph';

/**
 * The ONE door. Every way a flow reaches Genie goes through `executors.ts`.
 *
 * What these tests defend, in order of how badly it would hurt:
 *
 *   1. A Fancy builtin like `api_request` — arbitrary outbound HTTP — must never
 *      reach Genie or the network. fancy-flow ships no executor for it, so it is
 *      inert *unless a host implements it*. Genie refuses it, and this asserts
 *      that rather than trusting it.
 *   2. A node cannot name the app it acts as. Identity comes from the run, the
 *      way it comes from the window in `bridge.ts`.
 *   3. A refusal STOPS the flow. A refused step that let the graph carry on would
 *      turn "permission denied" into "silently did half the automation".
 *
 * ## Every node here goes through the real `runFlow`
 *
 * This file used to call `executors[node.type]` itself. That assumed away the
 * thing most worth checking — whether the engine can FIND the executor — and it
 * is how the coarse-type bug survived: the suite hand-wrote graphs in a shape
 * `<FlowEditor>` stopped producing at v0.48, so every node a user could actually
 * drag onto the canvas aborted while the tests stayed green.
 *
 * So `runNode` drives `runFlow` on a one-node graph, and the nodes come from
 * {@link newFlowNode} — the same function that builds a node everywhere else in
 * Genie, and a mirror of the editor's `addNode`. A test that builds its input in
 * a shape the product cannot produce is not testing the product.
 */

const dispatchOk = (): FlowDispatch =>
    vi.fn(async () => ({ ok: true as const, result: { done: true } }));

/** A node of `kind`, built the way the canvas builds one, with `config` applied. */
function node(id: string, kind: string, config?: Record<string, unknown>) {
    const built = newFlowNode(kind, { x: 0, y: 0 }, id);
    if (!built) throw new Error(`no registered kind called ${kind}`);
    if (config) built.data.config = { ...built.data.config, ...config };
    return built;
}

/**
 * Run ONE node through the engine and hand back what it produced.
 *
 * Throws on a failed run, so the `.rejects.toThrow()` assertions below are about
 * the flow stopping — which is the property, not an implementation detail of how
 * an executor signals refusal.
 */
async function runNode(
    executors: ReturnType<typeof buildFlowExecutors>,
    n: { id: string },
    inputs: Record<string, unknown> = {},
) {
    const result = await runFlow({ nodes: [n], edges: [] } as never, executors as never, () => {}, {
        initialInputs: { [n.id]: inputs },
    });
    if (!result.ok) throw new Error(result.error);
    return (result.outputs as Record<string, unknown>)[n.id];
}

describe('a granted Genie step', () => {
    it('calls the tool its kind names, and hands back the result', async () => {
        const dispatch = dispatchOk();
        const out = await runNode(
            buildFlowExecutors({ kind: 'app', appId: 'com.example.trader' }, dispatch),
            genieNode('a', 'genie.manageSite', { action: 'list' }),
        );

        expect(dispatch).toHaveBeenCalledWith({ kind: 'app', appId: 'com.example.trader' }, {
            tool: 'manageSite',
            args: { action: 'list' },
            workspaceId: undefined,
        });
        expect(out).toEqual({ done: true });
    });

    it('forwards the workspace the step targets', async () => {
        const dispatch = dispatchOk();
        await runNode(
            buildFlowExecutors({ kind: 'app', appId: 'app' }, dispatch),
            genieNode('a', 'genie.manageSite', { workspaceId: 'ws-two', action: 'list' }),
        );

        expect(dispatch).toHaveBeenCalledWith({ kind: 'app', appId: 'app' }, {
            tool: 'manageSite',
            args: { workspaceId: 'ws-two', action: 'list' },
            workspaceId: 'ws-two',
        });
    });

    it('acts as the app the RUN belongs to, whatever the node claims', async () => {
        // The `bridge.ts` rule, restated for flows: identity comes from the run,
        // never from the graph. A graph is data an app can write.
        const dispatch = dispatchOk();
        await runNode(
            buildFlowExecutors({ kind: 'app', appId: 'the-real-app' }, dispatch),
            genieNode('a', 'genie.manageSite', { appId: 'some-other-app' }),
        );

        expect(dispatch).toHaveBeenCalledWith({ kind: 'app', appId: 'the-real-app' }, expect.anything());
    });
});

/**
 * A Genie node, hand-built.
 *
 * Genie's kinds are not in fancy's registry yet at this layer, so `newFlowNode`
 * cannot make one — but the SHAPE must be identical to what it produces, or this
 * file reintroduces the very drift it exists to prevent. Asserted below.
 */
function genieNode(id: string, kind: string, config: Record<string, unknown> = {}) {
    return { id, type: kind, position: { x: 0, y: 0 }, data: { kind, label: id, config } };
}

describe('a hand-built Genie node', () => {
    it('has the same shape a canvas-built node has', () => {
        const canvas = node('c', '@particle-academy/log');
        const genie = genieNode('g', 'genie.manageSite');

        // `type === data.kind` is the invariant that broke. Pinning it here stops
        // the helper above drifting from `newFlowNode` unnoticed.
        expect(canvas.type).toBe(canvas.data.kind);
        expect(genie.type).toBe(genie.data.kind);
        expect(Object.keys(genie.data).sort()).toEqual(Object.keys(canvas.data).sort());
    });
});

describe('a step that must never reach Genie', () => {
    it('aborts on a Fancy builtin, and never calls the bridge', async () => {
        // `api_request` is arbitrary outbound HTTP. fancy-flow ships no executor
        // for it, so it does nothing unless a host implements one. Genie does not
        // — and a GApp flow must not be able to exfiltrate through a node kind
        // nobody classified.
        const dispatch = dispatchOk();
        const executors = buildFlowExecutors({ kind: 'app', appId: 'app' }, dispatch);

        await expect(runNode(executors, node('x', '@particle-academy/api_request'))).rejects.toThrow(
            /arbitrary web requests/,
        );
        await expect(runNode(executors, node('y', '@particle-academy/webhook_out'))).rejects.toThrow(
            /arbitrary URLs/,
        );
        expect(dispatch).not.toHaveBeenCalled();
    });

    it('aborts on a forged kind naming an ungrantable tool', async () => {
        const dispatch = dispatchOk();

        await expect(
            runNode(buildFlowExecutors({ kind: 'app', appId: 'app' }, dispatch), genieNode('x', 'genie.submitFeedback')),
        ).rejects.toThrow();
        expect(dispatch).not.toHaveBeenCalled();
    });

    it('aborts on a node with no kind at all', async () => {
        const dispatch = dispatchOk();
        const bare = { id: 'x', position: { x: 0, y: 0 }, data: { label: 'x' } };

        await expect(
            runNode(buildFlowExecutors({ kind: 'app', appId: 'app' }, dispatch), bare as never),
        ).rejects.toThrow();
        expect(dispatch).not.toHaveBeenCalled();
    });

    it('aborts on a marketplace node Genie never took, rather than skipping it', async () => {
        // A kind from a package Genie does not vendor, or from a newer fancy-flow
        // than this build knows. Unconsidered must mean refused, not ignored.
        const dispatch = dispatchOk();

        await expect(
            runNode(
                buildFlowExecutors({ kind: 'app', appId: 'app' }, dispatch),
                { id: 'x', type: '@acme/salesforce_upsert', position: { x: 0, y: 0 },
                  data: { kind: '@acme/salesforce_upsert', label: 'x', config: {} } } as never,
            ),
        ).rejects.toThrow(/does not know how to run/);
        expect(dispatch).not.toHaveBeenCalled();
    });

    it('refuses a subflow, because whose permissions it would run under is undecided', async () => {
        // Was asserted by the ABSENCE of a `subgraph` registry key, which a
        // wildcard registry makes vacuously true. Assert the behaviour instead.
        await expect(
            runNode(buildFlowExecutors({ kind: 'app', appId: 'app' }, dispatchOk()), node('s', '@particle-academy/subflow')),
        ).rejects.toThrow(/whose permissions/);
    });
});

describe('a refusal from the bridge', () => {
    it('stops the flow rather than letting it carry on', async () => {
        // The failure this prevents: a denied step returning undefined, the graph
        // continuing, and an automation completing "successfully" having skipped
        // the part the user said no to.
        const dispatch: FlowDispatch = vi.fn(async () => ({
            ok: false as const,
            error: '“Trader” was not granted “Run commands”.',
        }));

        await expect(
            runNode(buildFlowExecutors({ kind: 'app', appId: 'app' }, dispatch), genieNode('x', 'genie.manageTerminals')),
        ).rejects.toThrow(/Run commands/);
    });
});

describe('the built-in logic steps Genie implements', () => {
    it('starts a run from a trigger', async () => {
        const out = await runNode(
            buildFlowExecutors({ kind: 'app', appId: 'app' }, dispatchOk()),
            node('t', '@particle-academy/manual_trigger'),
        );

        expect(out).toBeDefined();
    });

    it('passes a value through an output node', async () => {
        const out = await runNode(
            buildFlowExecutors({ kind: 'app', appId: 'app' }, dispatchOk()),
            node('o', '@particle-academy/output'),
            { value: 42 },
        );

        expect(out).toBe(42);
    });

    it('routes true and false on a real condition', async () => {
        const executors = buildFlowExecutors({ kind: 'app', appId: 'app' }, dispatchOk());
        const branchOn = (right: string) =>
            node('d', '@particle-academy/branch', {
                match: 'all',
                conditions: [{ left: '{{ value }}', operator: 'eq', right }],
            });

        expect(await runNode(executors, branchOn('hit'), { value: 'hit' })).toMatchObject({
            branch: 'true',
        });
        expect(await runNode(executors, branchOn('hit'), { value: 'miss' })).toMatchObject({
            branch: 'false',
        });
    });

    it('refuses a branch with no conditions instead of guessing a direction', async () => {
        await expect(
            runNode(
                buildFlowExecutors({ kind: 'app', appId: 'app' }, dispatchOk()),
                node('d', '@particle-academy/branch', { conditions: [] }),
            ),
        ).rejects.toThrow(/no conditions/);
    });
});

describe('end to end, through the real engine', () => {
    it('runs a two-step flow and calls the bridge once', async () => {
        const dispatch = dispatchOk();
        const graph = {
            nodes: [
                node('t', '@particle-academy/manual_trigger'),
                genieNode('a', 'genie.manageSite', { action: 'list' }),
            ],
            edges: [{ id: 'e', source: 't', target: 'a' }],
        };

        const res = await runFlow(graph as never, buildFlowExecutors({ kind: 'app', appId: 'app' }, dispatch) as never);

        expect(res.ok).toBe(true);
        expect(dispatch).toHaveBeenCalledTimes(1);
    });

    it('fails the whole run when a step is refused', async () => {
        const dispatch: FlowDispatch = vi.fn(async () => ({ ok: false as const, error: 'no' }));
        const graph = {
            nodes: [
                node('t', '@particle-academy/manual_trigger'),
                genieNode('a', 'genie.manageTerminals'),
                genieNode('b', 'genie.manageSite'),
            ],
            edges: [
                { id: 'e1', source: 't', target: 'a' },
                { id: 'e2', source: 'a', target: 'b' },
            ],
        };

        const res = await runFlow(graph as never, buildFlowExecutors({ kind: 'app', appId: 'app' }, dispatch) as never);

        expect(res.ok).toBe(false);
        // The step AFTER the refused one never ran — the whole point.
        expect(dispatch).toHaveBeenCalledTimes(1);
    });
});

/**
 * fancy-flow 0.66.0 shipped DEFAULT executors. Genie's still win.
 *
 * The bump gave `branch`, `transform`, `merge` and `for_each` an `executor` on
 * the kind definition, and `pickExecutor` gained a fallback to it:
 *
 *     for (const id of executorLookupIds(node)) if (executors[id]) return executors[id];
 *     return getNodeKind(node.type ?? '')?.executor;      // ← new in 0.66.0
 *
 * The fallback is unreachable here, because `executorLookupIds` ends in `"*"`
 * and Genie's registry is wildcard-only — so the door is hit on every node and
 * the defaults are never consulted. The header of `executors.ts` used to say
 * `runFlow` "never consults" a kind's executor; that stopped being true at this
 * bump, and the property now rests on the wildcard rather than on the engine.
 *
 * Which is a property worth a test rather than a sentence. Genie's executors are
 * not drop-in equivalents of the new defaults — they are deliberately stricter,
 * and one of them refuses outright — so if ours quietly stopped being used, the
 * flows would not break loudly. They would keep running and mean something else.
 *
 * Each of these asserts a BEHAVIOUR the two implementations disagree about, so
 * "ours ran" is what is being measured, not what is in a registry.
 */
describe('after the 0.66.0 bump, Genie’s own executors still run', () => {
    const executors = () => buildFlowExecutors({ kind: 'app', appId: 'app' }, dispatchOk());

    it('still REFUSES for_each, which the package would now happily run', async () => {
        // 0.66.0's `forEachExecutor` resolves the list and returns
        // `{ items, count }` — it publishes the collection and its size rather
        // than repeating the steps after it. That is not what a person drawing
        // a loop is asking for, so Genie refuses instead of half-delivering,
        // and the refusal says what to do instead.
        //
        // This is the sharpest of the three: if the default took over, the run
        // would SUCCEED.
        await expect(
            runNode(
                executors(),
                node('l', '@particle-academy/for_each', { source: '{{ value }}' }),
                { value: [1, 2, 3] },
            ),
        ).rejects.toThrow(/repeat the steps|Run Agent/i);
    });

    it('still throws on an unresolved path in a transform, where the default resolves it away', async () => {
        // Genie resolves with `onUnresolved: 'throw'`; the default uses the
        // engine's `'empty'`, which turns `{{ nothing.here }}` into null and
        // carries on. A misspelled path that quietly becomes nothing gives a
        // run that reports success and means something else — the whole reason
        // Genie sets the stricter policy.
        //
        // Matched on the engine's own message, so it cannot pass on some other
        // failure that happens to reject.
        await expect(
            runNode(
                executors(),
                node('x', '@particle-academy/transform', {
                    mode: 'expression',
                    expression: '{{ nothing.here }}',
                }),
            ),
        ).rejects.toThrow(/did not resolve/);
    });

    it('still aborts a branch with no conditions, where the default routes false', async () => {
        // The default sets `taken = false` for an empty condition list and
        // returns the `false` port — a successful run down a direction nobody
        // chose. Genie stops where the mistake is.
        await expect(
            runNode(executors(), node('d', '@particle-academy/branch', { conditions: [] })),
        ).rejects.toThrow(/no conditions/);
    });

    it('CONTROL: the door is still passing real work through', async () => {
        // Every assertion above is a rejection, and a door that refused
        // EVERYTHING would satisfy all three. This is the positive control:
        // Genie's `log` executor runs, and hands its input on.
        expect(await runNode(executors(), node('g', '@particle-academy/log'), { value: 7 })).toBe(7);
    });
});

/**
 * The four node kinds fancy-flow 0.66.0 added, and what Genie does with them.
 *
 * `terminal_run` / `terminal_send` / `terminal_await` drive a pty through the
 * package's new `TerminalHost` capability — a host registers one with
 * `registerTerminalHost`, and nothing does here. They arrived in the palette on
 * a version bump nobody asked for terminals in, and they sit in the `io`
 * category, right beside Genie's own steps.
 *
 * Genie already owns terminals, properly: they are real, visible, attributed to
 * an agent, and reachable from a flow through the Manage Terminals step. A
 * second, invisible shell that only the flow engine knows about is not a feature
 * Genie is missing — it is one it declines. So they are refused with that said
 * out loud, rather than falling through to the generic "Genie does not know how
 * to run this", which is true of a kind nobody has considered and misleading
 * about one that has been.
 *
 * `terminal_lane` is the fourth and is NOT refused: it is a `layout` kind, and
 * the engine skips the whole category before an executor is ever chosen. A
 * refusal for it would be dead code that reads like live defence.
 */
describe('the terminal steps fancy-flow 0.66.0 added', () => {
    const executors = () => buildFlowExecutors({ kind: 'app', appId: 'app' }, dispatchOk());

    /** The abort message, or null if the run somehow succeeded. */
    const refusalFrom = async (kind: string): Promise<string | null> => {
        try {
            await runNode(executors(), node('t', kind));
            return null;
        } catch (e) {
            return e instanceof Error ? e.message : String(e);
        }
    };

    it.each([
        ['@particle-academy/terminal_run'],
        ['@particle-academy/terminal_send'],
        ['@particle-academy/terminal_await'],
    ])('refuses %s with a STATED reason, not the catch-all', async (kind) => {
        const message = await refusalFrom(kind);

        expect(message).toMatch(/terminal/i);
        // The half that matters. All three were already refused before this
        // change — by case 4 of the door, the catch-all for a kind nobody has
        // considered. These have been considered, and saying "Genie does not
        // know how to run this" about them is misleading rather than merely
        // unhelpful: it reads as a bug to report.
        expect(message).not.toMatch(/does not know how to run/);
    });

    it('points at the step Genie does have', async () => {
        expect(await refusalFrom('@particle-academy/terminal_run')).toMatch(/Manage Terminals/);
    });

    it('never reaches the door for terminal_lane, because the engine skips layout', async () => {
        // Asserting the skip rather than a refusal. If the engine ever stopped
        // skipping `layout`, this goes red and says so — which is the moment a
        // refusal WOULD be needed.
        await expect(
            runNode(executors(), node('lane', '@particle-academy/terminal_lane')),
        ).resolves.toBeUndefined();
    });
});
