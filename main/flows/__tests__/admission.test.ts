import { describe, expect, it } from 'vitest';
import { decideFlowAdmission, type FlowGraphLike } from '../admission';
import type { AppGrant } from '../../apps/bridge-decision';

/**
 * May this app run this graph — decided BEFORE the first node executes.
 *
 * A flow graph is inert JSON and every effectful step names its tool
 * structurally, so unlike an agent transcript a whole flow can be judged up
 * front. That is worth doing for one blunt reason: refusing at node 7, after six
 * irreversible side effects, is a strictly worse answer than refusing at node 0.
 *
 * This is NOT the enforcement. `dispatchAppCall` in the executor is, and it stays
 * even for an admitted graph, because a graph can be edited between admission and
 * run. Admission is fail-fast and an honest explanation; the bridge is the lock.
 *
 * Every refusal here delegates to `decideAppCall`, so a flow can never be a
 * second, laxer authority path beside the one agents use.
 */

const grant = (over: Partial<AppGrant> = {}): AppGrant => ({
    appId: 'com.example.trader',
    appName: 'Example Trader',
    workspaceId: 'ws-app',
    scope: 'self',
    capabilities: ['hosting', 'files'],
    revoked: false,
    ...over,
});

const node = (id: string, kind: string, over: Record<string, unknown> = {}) => ({
    id,
    type: 'action',
    data: { kind, label: id, ...over },
});

const graph = (...nodes: ReturnType<typeof node>[]): FlowGraphLike => ({ nodes, edges: [] });

describe('a graph the app was granted', () => {
    it('is admitted, and reports which capabilities it uses', () => {
        const d = decideFlowAdmission(
            graph(node('a', 'genie.manageSite'), node('b', 'genie.openFileForUser')),
            grant(),
        );

        expect(d.allowed).toBe(true);
        expect(d.refusals).toEqual([]);
        expect(d.capabilities.sort()).toEqual(['files', 'hosting']);
    });

    it('reports a capability once, however many nodes use it', () => {
        const d = decideFlowAdmission(
            graph(node('a', 'genie.manageSite'), node('b', 'genie.manageService')),
            grant(),
        );

        expect(d.capabilities).toEqual(['hosting']);
    });

    it('admits a graph with no Genie nodes at all', () => {
        const d = decideFlowAdmission(graph(node('a', '@particle-academy/branch')), grant());

        expect(d.allowed).toBe(true);
        expect(d.capabilities).toEqual([]);
    });
});

describe('a graph reaching past the grant', () => {
    it('is refused, naming the node and the missing capability', () => {
        const d = decideFlowAdmission(
            graph(node('a', 'genie.manageSite'), node('danger', 'genie.manageTerminals')),
            grant(),
        );

        expect(d.allowed).toBe(false);
        expect(d.refusals).toHaveLength(1);
        expect(d.refusals[0]!.nodeId).toBe('danger');
        expect(d.refusals[0]!.reason).toContain('Run commands');
    });

    it('reports EVERY offending node, not just the first', () => {
        // An author fixing one node at a time, told about one node at a time, is
        // the worst version of this. Admission sees the whole graph, so it says
        // everything that is wrong with it in one pass.
        const d = decideFlowAdmission(
            graph(
                node('x', 'genie.manageTerminals'),
                node('ok', 'genie.manageSite'),
                node('y', 'genie.runAgent'),
            ),
            grant(),
        );

        expect(d.refusals.map((r) => r.nodeId)).toEqual(['x', 'y']);
    });

    it('refuses a node naming an ungrantable tool, however the app was granted', () => {
        const d = decideFlowAdmission(
            graph(node('sneaky', 'genie.submitFeedback')),
            grant({ capabilities: ['hosting', 'files', 'notify', 'terminals'] }),
        );

        expect(d.allowed).toBe(false);
        expect(d.refusals[0]!.nodeId).toBe('sneaky');
    });

    it('refuses a node in Genie’s namespace that names no real tool', () => {
        // A kind Genie has no executor for would fail closed inside `runFlow`
        // anyway — but only after everything upstream of it had already run. A
        // step CLAIMING to be a Genie step and resolving to nothing is a broken
        // graph, and the honest place to say so is before anything happens.
        const d = decideFlowAdmission(graph(node('typo', 'genie.mangeTerminals')), grant());

        expect(d.allowed).toBe(false);
        expect(d.refusals[0]!.nodeId).toBe('typo');
    });

    it('still admits a Fancy builtin, which is not Genie’s namespace at all', () => {
        // The distinction that matters: `@particle-academy/*` legitimately is not
        // a Genie node, so it is none of admission's business. Only a `genie.`
        // kind that fails to resolve is a broken graph.
        expect(decideFlowAdmission(graph(node('b', '@particle-academy/merge')), grant()).allowed).toBe(
            true,
        );
    });

    it('refuses a node targeting a workspace outside the app’s scope', () => {
        const d = decideFlowAdmission(
            graph(node('a', 'genie.manageSite', { config: { workspaceId: 'ws-somebody-else' } })),
            grant(),
        );

        expect(d.allowed).toBe(false);
        expect(d.refusals[0]!.nodeId).toBe('a');
    });

    it('admits a node targeting a workspace the app WAS scoped to', () => {
        const d = decideFlowAdmission(
            graph(node('a', 'genie.manageSite', { config: { workspaceId: 'ws-two' } })),
            grant({ scope: 'workspaces', workspaces: ['ws-app', 'ws-two'] }),
        );

        expect(d.allowed).toBe(true);
    });
});

describe('a graph with no standing to run at all', () => {
    it('refuses the whole graph when there is no grant', () => {
        const d = decideFlowAdmission(graph(node('a', 'genie.manageSite')), null);

        expect(d.allowed).toBe(false);
        expect(d.reason).toBeTruthy();
    });

    it('refuses the whole graph when the app is revoked, even if every node is fine', () => {
        // Revocation is total and immediate. A stored flow is exactly the kind of
        // thing that would otherwise keep running after the user said stop.
        const d = decideFlowAdmission(
            graph(node('a', 'genie.manageSite')),
            grant({ revoked: true }),
        );

        expect(d.allowed).toBe(false);
        expect(d.reason).toContain('revoked');
    });

    it('refuses an empty graph rather than pretending it ran', () => {
        const d = decideFlowAdmission(graph(), grant());

        expect(d.allowed).toBe(false);
        expect(d.reason).toBeTruthy();
    });
});

describe('malformed input, which is the normal case for a stored graph', () => {
    // `importWorkflow` coerces garbage to an empty graph rather than rejecting it,
    // so this module must be the one that is strict. It reads UNTRUSTED shape.
    it('survives a graph that is not a graph', () => {
        for (const junk of [null, undefined, 'nope', 42, [], {}] as unknown[]) {
            expect(() => decideFlowAdmission(junk as FlowGraphLike, grant())).not.toThrow();
            expect(decideFlowAdmission(junk as FlowGraphLike, grant()).allowed).toBe(false);
        }
    });

    it('survives nodes that are not nodes', () => {
        const junk = { nodes: [null, 'x', 7, {}, { id: 'a' }] } as unknown as FlowGraphLike;

        expect(() => decideFlowAdmission(junk, grant())).not.toThrow();
    });

    it('ignores a node whose kind is not a string', () => {
        const junk = {
            nodes: [{ id: 'a', data: { kind: { toString: () => 'genie.manageTerminals' } } }],
        } as unknown as FlowGraphLike;

        // A kind must BE a string to resolve. An object that stringifies into a
        // tool name is exactly the sort of thing that should find nothing.
        expect(decideFlowAdmission(junk, grant()).refusals).toEqual([]);
    });

    it('refuses a node whose workspace target is not a string', () => {
        const junk = {
            nodes: [
                { id: 'a', data: { kind: 'genie.manageSite', config: { workspaceId: ['ws-app'] } } },
            ],
        } as unknown as FlowGraphLike;

        // Not silently treated as "the app's own workspace" — a target nobody can
        // read is a target nobody should act on.
        expect(decideFlowAdmission(junk, grant()).allowed).toBe(false);
    });
});
