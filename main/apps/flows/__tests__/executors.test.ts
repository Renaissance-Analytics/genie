import { describe, expect, it, vi } from 'vitest';
import { runFlow } from '@particle-academy/fancy-flow/engine';
import { buildFlowExecutors, type FlowDispatch } from '../executors';

/**
 * The ONE door. Every way a flow reaches Genie goes through this file.
 *
 * fancy-flow dispatches executors on the six coarse node types, never on
 * `data.kind` (verified — see the research note). That is usually described as a
 * footgun, and it is, but taken deliberately it is the better security shape:
 * Genie registers a SINGLE `action` executor, and that function is the only place
 * a node's kind is turned into a Genie call. There is no per-kind executor that
 * could be added later with its own path to the bridge.
 *
 * What these tests defend, in order of how badly it would hurt:
 *
 *   1. A Fancy builtin like `api_request` — arbitrary outbound HTTP — must never
 *      reach Genie or the network. fancy-flow ships no executor for it, so it is
 *      inert *unless a host implements it*. Genie does not, and this asserts that
 *      staying true rather than trusting it to.
 *   2. A node cannot name the app it acts as. Identity comes from the run, the
 *      way it comes from the window in `bridge.ts`.
 *   3. A refusal STOPS the flow. A refused step that let the graph carry on would
 *      turn "permission denied" into "silently did half the automation".
 */

const dispatchOk = (): FlowDispatch =>
    vi.fn(async () => ({ ok: true as const, result: { done: true } }));

const node = (id: string, type: string, kind: string, config?: Record<string, unknown>) => ({
    id,
    type,
    position: { x: 0, y: 0 },
    data: { kind, label: id, ...(config ? { config } : {}) },
});

/** Call one executor directly, with the ctx `runFlow` would have built. */
async function runNode(
    executors: ReturnType<typeof buildFlowExecutors>,
    n: ReturnType<typeof node>,
    inputs: Record<string, unknown> = {},
) {
    const executor = executors[n.type as keyof typeof executors];
    if (!executor) throw new Error(`no executor for type ${n.type}`);
    const abort = (reason?: string) => {
        throw new Error(reason ?? 'aborted');
    };
    return executor({ node: n as never, inputs, abort: abort as never, emit: () => {} });
}

describe('a granted Genie step', () => {
    it('calls the tool its kind names, and hands back the result', async () => {
        const dispatch = dispatchOk();
        const out = await runNode(
            buildFlowExecutors('com.example.trader', dispatch),
            node('a', 'action', 'genie.manageSite', { action: 'list' }),
        );

        expect(dispatch).toHaveBeenCalledWith('com.example.trader', {
            tool: 'manageSite',
            args: { action: 'list' },
            workspaceId: undefined,
        });
        expect(out).toEqual({ done: true });
    });

    it('forwards the workspace the step targets', async () => {
        const dispatch = dispatchOk();
        await runNode(
            buildFlowExecutors('app', dispatch),
            node('a', 'action', 'genie.manageSite', { workspaceId: 'ws-two', action: 'list' }),
        );

        expect(dispatch).toHaveBeenCalledWith('app', {
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
            buildFlowExecutors('the-real-app', dispatch),
            node('a', 'action', 'genie.manageSite', { appId: 'some-other-app' }),
        );

        expect(dispatch).toHaveBeenCalledWith('the-real-app', expect.anything());
    });
});

describe('a step that must never reach Genie', () => {
    it('aborts on a Fancy builtin, and never calls the bridge', async () => {
        // `api_request` is arbitrary outbound HTTP. fancy-flow ships no executor
        // for it, so it does nothing unless a host implements one. Genie does not
        // — and a GApp flow must not be able to exfiltrate through a node kind
        // nobody classified.
        const dispatch = dispatchOk();
        const executors = buildFlowExecutors('app', dispatch);

        await expect(
            runNode(executors, node('x', 'action', '@particle-academy/api_request')),
        ).rejects.toThrow();
        await expect(
            runNode(executors, node('x', 'action', '@particle-academy/webhook_out')),
        ).rejects.toThrow();
        expect(dispatch).not.toHaveBeenCalled();
    });

    it('aborts on a forged kind naming an ungrantable tool', async () => {
        const dispatch = dispatchOk();

        await expect(
            runNode(
                buildFlowExecutors('app', dispatch),
                node('x', 'action', 'genie.submitFeedback'),
            ),
        ).rejects.toThrow();
        expect(dispatch).not.toHaveBeenCalled();
    });

    it('aborts on a node with no kind at all', async () => {
        const dispatch = dispatchOk();
        const bare = { id: 'x', type: 'action', position: { x: 0, y: 0 }, data: { label: 'x' } };

        await expect(
            runNode(buildFlowExecutors('app', dispatch), bare as never),
        ).rejects.toThrow();
        expect(dispatch).not.toHaveBeenCalled();
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
            runNode(
                buildFlowExecutors('app', dispatch),
                node('x', 'action', 'genie.manageTerminals'),
            ),
        ).rejects.toThrow(/Run commands/);
    });
});

describe('the rest of the six node types', () => {
    it('starts a run from a trigger', async () => {
        const out = await runNode(
            buildFlowExecutors('app', dispatchOk()),
            node('t', 'trigger', '@particle-academy/manual_trigger'),
        );

        expect(out).toBeDefined();
    });

    it('passes a value through an output node', async () => {
        const out = await runNode(
            buildFlowExecutors('app', dispatchOk()),
            node('o', 'output', '@particle-academy/output'),
            { value: 42 },
        );

        expect(out).toBe(42);
    });

    it('branches on the truthiness of its input', async () => {
        const executors = buildFlowExecutors('app', dispatchOk());
        const d = node('d', 'decision', '@particle-academy/branch');

        expect(await runNode(executors, d, { value: true })).toMatchObject({ branch: 'true' });
        expect(await runNode(executors, d, { value: 0 })).toMatchObject({ branch: 'false' });
    });

    it('leaves subgraph deliberately unregistered, so it fails closed', () => {
        // Flow-to-flow references need a resolver and an answer about whose grant
        // the child runs under. Until that is decided, a subflow node must not
        // half-work: `runFlow` aborts on an unregistered type.
        expect(buildFlowExecutors('app', dispatchOk())).not.toHaveProperty('subgraph');
    });
});

describe('end to end, through the real engine', () => {
    it('runs a two-step flow and calls the bridge once', async () => {
        const dispatch = dispatchOk();
        const graph = {
            nodes: [
                node('t', 'trigger', '@particle-academy/manual_trigger'),
                node('a', 'action', 'genie.manageSite', { action: 'list' }),
            ],
            edges: [{ id: 'e', source: 't', target: 'a' }],
        };

        const res = await runFlow(graph as never, buildFlowExecutors('app', dispatch) as never);

        expect(res.ok).toBe(true);
        expect(dispatch).toHaveBeenCalledTimes(1);
    });

    it('fails the whole run when a step is refused', async () => {
        const dispatch: FlowDispatch = vi.fn(async () => ({ ok: false as const, error: 'no' }));
        const graph = {
            nodes: [
                node('t', 'trigger', '@particle-academy/manual_trigger'),
                node('a', 'action', 'genie.manageTerminals'),
                node('b', 'action', 'genie.manageSite'),
            ],
            edges: [
                { id: 'e1', source: 't', target: 'a' },
                { id: 'e2', source: 'a', target: 'b' },
            ],
        };

        const res = await runFlow(graph as never, buildFlowExecutors('app', dispatch) as never);

        expect(res.ok).toBe(false);
        // The step AFTER the refusal must never have run.
        expect(dispatch).toHaveBeenCalledTimes(1);
    });
});
