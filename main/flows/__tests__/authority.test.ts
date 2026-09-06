import { describe, expect, it } from 'vitest';
import { decideFlowAdmission } from '../admission';
import { authorityForScope } from '../authority';
import type { AppGrant } from '../../apps/bridge-decision';

/**
 * Whose authority does a flow run under?
 *
 * Genie has one flow system and three scopes, and the scope decides this. It is
 * the one thing scope DOES decide — everywhere else scope is noise reduction and
 * nothing security-bearing may rest on it.
 *
 *   - `gapp`      → the owning app's grant. Exactly what the app could already
 *                   do from its own window, no more. A flow can do less than its
 *                   app, never more.
 *   - `workspace` → the USER, confined to that workspace.
 *   - `system`    → the USER, machine-wide.
 *
 * ## Why a user-scoped flow is not simply "allowed everything"
 *
 * Because nobody is watching. The recipe system this replaces reached the same
 * conclusion from the other direction: an unattended run may execute first-party
 * code and nothing else, because a shell step at 3am is a command nobody
 * sanctioned. Under graphs the same rule has a sharper form, since every step
 * names its tool STRUCTURALLY: a flow may call the tools an app could be granted,
 * and never an ungrantable one. `submitFeedback` is not a thing a timer does at
 * 3am, and the list of what is has already been written down once, in
 * `capabilities.ts`, where a test fails the build if a new tool is left out.
 *
 * ## A workspace flow must not touch another workspace
 *
 * The whole promise of the middle rung. A node naming a different workspace is
 * refused rather than silently retargeted — retargeting would make the flow do
 * something the author did not write.
 */

const grant = (over: Partial<AppGrant> = {}): AppGrant => ({
    appId: 'com.example.trader',
    appName: 'Trader',
    workspaceId: 'ws-1',
    scope: 'self',
    capabilities: ['terminals', 'hosting'],
    workspaces: [],
    revoked: false,
    ...over,
});

const node = (id: string, kind: string, config: Record<string, unknown> = {}) => ({
    id,
    type: kind,
    position: { x: 0, y: 0 },
    data: { kind, label: id, config },
});

const graph = (...nodes: ReturnType<typeof node>[]) => ({ nodes, edges: [] });

describe('a gapp flow runs as its app', () => {
    it('is admitted for a step the app holds', () => {
        const decision = decideFlowAdmission(
            graph(node('a', '@genie/manageTerminals')),
            authorityForScope({ kind: 'gapp', appId: 'com.example.trader' }, () => grant()),
        );

        expect(decision.allowed).toBe(true);
        expect(decision.capabilities).toContain('terminals');
    });

    it('is refused for a step the app does not hold', () => {
        const decision = decideFlowAdmission(
            graph(node('a', '@genie/knowledge')),
            authorityForScope({ kind: 'gapp', appId: 'com.example.trader' }, () => grant()),
        );

        expect(decision.allowed).toBe(false);
        expect(decision.refusals[0]?.nodeId).toBe('a');
    });

    it('is refused entirely when the app was revoked', () => {
        // Revocation is total, and it is checked before any node — a stored flow
        // is exactly the thing that would otherwise keep running after "stop".
        const decision = decideFlowAdmission(
            graph(node('a', '@genie/manageTerminals')),
            authorityForScope({ kind: 'gapp', appId: 'com.example.trader' }, () =>
                grant({ revoked: true }),
            ),
        );

        expect(decision.allowed).toBe(false);
        expect(decision.reason).toMatch(/revoked/i);
    });

    it('is refused when there is no grant at all', () => {
        const decision = decideFlowAdmission(
            graph(node('a', '@genie/manageTerminals')),
            authorityForScope({ kind: 'gapp', appId: 'gone' }, () => null),
        );

        expect(decision.allowed).toBe(false);
    });
});

describe('a user-scoped flow runs as the user', () => {
    const system = authorityForScope({ kind: 'system' }, () => null);

    it('admits any classified tool, without needing a grant', () => {
        const decision = decideFlowAdmission(
            graph(node('a', '@genie/manageTerminals'), node('b', '@genie/manageSite')),
            system,
        );

        expect(decision.allowed, decision.refusals.map((r) => r.reason).join('; ')).toBe(true);
    });

    it('refuses an UNGRANTABLE tool, even as the user', () => {
        // The list of what a timer may do at 3am was written down once, in
        // `capabilities.ts`. A user-scoped flow does not get its own, wider one.
        //
        // It is refused as naming nothing real, and that is the mechanism rather
        // than a coincidence: `nodes.ts` derives its map from classified tools
        // only, so an ungrantable tool has no node kind to resolve. Asserting
        // the message here would pin the wrong thing — what matters is that a
        // hand-written graph naming one does not run.
        const decision = decideFlowAdmission(graph(node('a', '@genie/submitFeedback')), system);

        expect(decision.allowed).toBe(false);
        expect(decision.refusals[0]?.nodeId).toBe('a');
    });

    it('refuses a kind in Genie’s namespace that names no real tool', () => {
        const decision = decideFlowAdmission(graph(node('a', '@genie/notAThing')), system);

        expect(decision.allowed).toBe(false);
    });

    it('lets fancy’s own logic steps through — they reach nothing', () => {
        const decision = decideFlowAdmission(
            graph(node('a', '@particle-academy/branch'), node('b', '@particle-academy/log')),
            system,
        );

        expect(decision.allowed).toBe(true);
    });
});

describe('a workspace flow stays in its workspace', () => {
    const inWs7 = authorityForScope({ kind: 'workspace', workspaceId: 'ws-7' }, () => null);

    it('is admitted for a step that names its own workspace', () => {
        const decision = decideFlowAdmission(
            graph(node('a', '@genie/manageSite', { workspaceId: 'ws-7' })),
            inWs7,
        );

        expect(decision.allowed).toBe(true);
    });

    it('is admitted for a step that names no workspace — it means its own', () => {
        const decision = decideFlowAdmission(graph(node('a', '@genie/manageSite')), inWs7);

        expect(decision.allowed).toBe(true);
    });

    it('REFUSES a step naming another workspace, rather than retargeting it', () => {
        // Retargeting would make the flow do something the author did not write,
        // which is worse than refusing to run it.
        const decision = decideFlowAdmission(
            graph(node('a', '@genie/manageSite', { workspaceId: 'ws-OTHER' })),
            inWs7,
        );

        expect(decision.allowed).toBe(false);
        expect(decision.refusals[0]?.reason).toMatch(/another workspace/i);
    });

    it('refuses a workspace id it cannot read', () => {
        const decision = decideFlowAdmission(
            graph(node('a', '@genie/manageSite', { workspaceId: 42 })),
            inWs7,
        );

        expect(decision.allowed).toBe(false);
    });
});

describe('a system flow may act anywhere', () => {
    it('admits a step naming any workspace', () => {
        const decision = decideFlowAdmission(
            graph(node('a', '@genie/manageSite', { workspaceId: 'ws-anything' })),
            authorityForScope({ kind: 'system' }, () => null),
        );

        expect(decision.allowed).toBe(true);
    });
});

describe('graphs that cannot be judged', () => {
    const system = authorityForScope({ kind: 'system' }, () => null);

    it('refuses an unreadable graph rather than running it', () => {
        expect(decideFlowAdmission(null, system).allowed).toBe(false);
        expect(decideFlowAdmission({ nodes: 'nope' } as never, system).allowed).toBe(false);
    });

    it('refuses an EMPTY graph, because that is nearly always a bad edit', () => {
        expect(decideFlowAdmission({ nodes: [], edges: [] }, system).allowed).toBe(false);
    });

    it('refuses a flow whose scope could not be read', () => {
        // Not "run it as system". A row whose scope will not parse must never
        // resolve to the WIDEST authority.
        expect(decideFlowAdmission(graph(node('a', '@genie/manageSite')), null).allowed).toBe(false);
    });
});

describe('a step that would park a run Genie cannot resume', () => {
    const system = authorityForScope({ kind: 'system' }, () => null);

    /**
     * fancy-flow's human nodes pause by aborting with a structured token, and
     * the host resumes by replaying the run with `resumeOutputs`. Genie decodes
     * the token and does not yet resume — so today these stop a run for good.
     *
     * A flow you can draw, arm, and then watch hang forever with no indication
     * that the step it waits on can never complete is a TRAP, and a worse one
     * than a missing feature: it looks like it works. So they are refused, and
     * refused HERE — at admission — because that is what the canvas checks
     * continuously while an author draws, which is the only moment the refusal
     * is cheap to act on.
     *
     * They are no longer OFFERED, either: fancy-flow 0.66.0 added `kindFilter`
     * (the answer to the issue Genie filed when the only lever was node
     * CATEGORY), and `paletteKindFilter` drives it off this same list. That
     * removes the trap — you cannot drag one on.
     *
     * It does not remove the need for THIS test. A palette filter is
     * presentation; it only ever sees the sidebar. A graph that was
     * hand-authored, imported, or written by an agent through `manageFlows`
     * reaches admission without passing a palette at all, which is why the
     * refusal stays and why it is asserted here rather than assumed.
     */
    it.each([
        ['@particle-academy/human_approval'],
        ['@particle-academy/user_input'],
        ['@particle-academy/rich_user_input'],
    ])('refuses %s, and says why', (kind) => {
        const decision = decideFlowAdmission(graph(node('h', kind)), system);

        expect(decision.allowed).toBe(false);
        expect(decision.refusals[0]?.nodeId).toBe('h');
        expect(decision.refusals[0]?.reason).toMatch(/cannot resume|waiting|pause/i);
    });

    it('still admits the logic steps beside them (control)', () => {
        // Without this, a rule that refused EVERYTHING would pass the above.
        expect(decideFlowAdmission(graph(node('b', '@particle-academy/branch')), system).allowed).toBe(
            true,
        );
    });

    it('still admits Genie’s own way of asking, which returns instead of parking', () => {
        // `ForceTheQuestion` asks and comes back immediately; the answer arrives
        // later through AgentInbox. It does not park a run, so it is not part of
        // this refusal — and a rule that swept it up would remove the one way a
        // flow can involve a person at all.
        expect(
            decideFlowAdmission(graph(node('q', '@genie/ForceTheQuestion')), system).allowed,
        ).toBe(true);
    });
});
