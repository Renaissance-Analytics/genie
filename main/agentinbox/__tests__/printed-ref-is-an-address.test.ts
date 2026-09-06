import { describe, expect, it } from 'vitest';
import { AgentInboxBroker } from '../broker';
import { resolveAgentAddress } from '../address';
import type { AgentInboxJoinInput } from '../types';

/**
 * WHAT `list` PRINTS, `send` MUST ACCEPT (genie#388).
 *
 * Three agents hit the same wall independently and each worked around it the
 * same way, by falling back to the raw uuid. `fancy` put it best: **"a form a
 * tool PRINTS and then REFUSES is a bug in the printing."**
 *
 * The two halves had drifted apart in different directions and nothing tested
 * them together:
 *
 *   - `agentRef` stopped putting the tui in a ref (`ddece5f7`, correct for the
 *     v55 schema), so `list` published `{name}` or `{name}:{chat}`;
 *   - `address.ts` still only recognised a tag whose head is a known TUI, so a
 *     bare name fell through to the uuid passthrough and the broker answered
 *     `No agent "genie"` — while the SAME tool's other error listed `genie` as
 *     reachable, because that list is built from the published refs.
 *
 * Both modules' own suites were green throughout. `address.test.ts` hand-writes
 * `ref: 'claude:tynn'` in its fixtures — a format the emitter had stopped
 * producing — and `identity-is-not-the-tui.test.ts` asserted the emitter never
 * produces it. Two green suites describing incompatible worlds.
 *
 * So this test does not assert a FORMAT. It takes whatever the real broker
 * publishes and requires the real resolver to accept it, which holds whichever
 * way the format decision goes next.
 */

function input(over: Partial<AgentInboxJoinInput> & { agentId: string }): AgentInboxJoinInput {
    return {
        terminalId: `t-${over.agentId}`,
        workspaceId: 'ws-1',
        workspaceName: 'Workspace One',
        slug: 'demo',
        agentType: 'claude',
        label: `Agent ${over.agentId}`,
        purpose: 'general',
        scope: 'self',
        scopeWorkspaces: [],
        chatSessionId: null,
        ...over,
    };
}

/** The caller, plus the two peers whose refs were reported as unusable. */
function peopled(): AgentInboxBroker {
    const b = new AgentInboxBroker();
    b.join(input({ agentId: 'uuid-caller', purpose: 'weaver' }));
    // `claude · fancy`, whose printed ref carried a chat id.
    b.join(input({ agentId: 'uuid-fancy', purpose: 'fancy', chatSessionId: 'cd2553a2-0f1e' }));
    // The workstation operator: another workspace, reachable from everywhere.
    b.join(
        input({
            agentId: 'genie:workstation',
            terminalId: 'genie-workstation-agent',
            workspaceId: '__system__',
            workspaceName: 'Genie',
            slug: 'genie',
            purpose: 'genie',
            scope: 'all',
        }),
    );
    return b;
}

describe('every ref `list` publishes is an address `send` accepts (genie#388)', () => {
    it('holds for EVERY peer in the directory, not just the one that was reported', () => {
        const b = peopled();
        const peers = b.discoverableFor('uuid-caller');

        // The invariant is worth nothing if the directory came back empty, and
        // "empty" is exactly what a broken scope filter returns.
        expect(peers.map((p) => p.agentId).sort()).toEqual(['genie:workstation', 'uuid-fancy']);

        for (const peer of peers) {
            expect(resolveAgentAddress(peer.ref, peers, 'ws-1')).toEqual({
                ok: true,
                agentId: peer.agentId,
            });
        }
    });

    it('accepts the DURABLE half of a ref that carries a chat id', () => {
        // A chat id is rebound on relaunch, so an agent that wrote down the
        // whole ref yesterday must still be able to use the stable part.
        const b = peopled();
        const peers = b.discoverableFor('uuid-caller');
        const fancy = peers.find((p) => p.agentId === 'uuid-fancy')!;

        expect(fancy.ref).toContain('fancy');
        const durable = fancy.ref.split(':').slice(0, 2).join(':');
        expect(resolveAgentAddress(durable, peers, 'ws-1')).toEqual({
            ok: true,
            agentId: 'uuid-fancy',
        });
    });

    it('accepts the operator by the ref its own row publishes', () => {
        // The reported errand: notify another workspace's agent about a runaway
        // process. The operator is the only agent that can cross workspaces, and
        // it was the one that could not be addressed at all.
        const b = peopled();
        const peers = b.discoverableFor('uuid-caller');
        const osa = peers.find((p) => p.agentId === 'genie:workstation')!;

        expect(resolveAgentAddress(osa.ref, peers, 'ws-1')).toEqual({
            ok: true,
            agentId: 'genie:workstation',
        });
    });

    it('a BARE name still resolves, because agents were told the old form', () => {
        // The refs printed before this fix were bare names, and agents have them
        // written down. Accepting one is also what makes `No agent "genie"`
        // impossible while the same tool's other message lists `genie`.
        const b = peopled();
        const peers = b.discoverableFor('uuid-caller');

        expect(resolveAgentAddress('genie', peers, 'ws-1')).toEqual({
            ok: true,
            agentId: 'genie:workstation',
        });
        expect(resolveAgentAddress('fancy', peers, 'ws-1')).toEqual({
            ok: true,
            agentId: 'uuid-fancy',
        });
    });

    it('refuses a bare name TWO agents answer to, naming both', () => {
        // v60 exists so `claude:tynn` and `codex:tynn` can both be agents. A
        // bare `tynn` is therefore genuinely ambiguous, and picking whichever
        // sorted first would deliver a human's instruction to the wrong agent —
        // silently, which is the failure this whole issue is about.
        const b = peopled();
        b.join(input({ agentId: 'uuid-twin-claude', purpose: 'twin', agentType: 'claude' }));
        b.join(input({ agentId: 'uuid-twin-codex', purpose: 'twin', agentType: 'codex' }));
        const peers = b.discoverableFor('uuid-caller');

        const got = resolveAgentAddress('twin', peers, 'ws-1');
        expect(got.ok).toBe(false);
        if (!got.ok) {
            expect(got.error).toContain('claude:twin');
            expect(got.error).toContain('codex:twin');
        }

        // …and each qualified form still resolves, so the error is actionable
        // rather than a dead end.
        expect(resolveAgentAddress('claude:twin', peers, 'ws-1')).toEqual({
            ok: true,
            agentId: 'uuid-twin-claude',
        });
        expect(resolveAgentAddress('codex:twin', peers, 'ws-1')).toEqual({
            ok: true,
            agentId: 'uuid-twin-codex',
        });
    });

    it('POSITIVE CONTROL: a name nobody publishes is still refused', () => {
        // Without this the whole file passes against a resolver that says yes to
        // everything, which would be a worse bug than the one being fixed.
        const b = peopled();
        const peers = b.discoverableFor('uuid-caller');

        const missing = resolveAgentAddress('claude:nobody', peers, 'ws-1');
        expect(missing.ok).toBe(false);
        if (!missing.ok) expect(missing.error).toMatch(/no agent matches/i);
    });

    it('POSITIVE CONTROL: a raw uuid still passes through untouched', () => {
        const b = peopled();
        const peers = b.discoverableFor('uuid-caller');

        expect(resolveAgentAddress('uuid-fancy', peers, 'ws-1')).toEqual({
            ok: true,
            agentId: 'uuid-fancy',
        });
    });
});
