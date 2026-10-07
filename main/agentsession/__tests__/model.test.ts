import { describe, expect, it } from 'vitest';
import {
    emptyAgentSession,
    knownFacts,
    sessionFidelity,
    type AgentSession,
} from '../model';

/**
 * The model's whole job is to keep "zero" and "we cannot see it" different
 * answers, because the UI renders them differently and a confusion between them
 * is a lie about an agent rather than a cosmetic bug.
 *
 * Genie has already paid for this distinction twice elsewhere and written it
 * down both times: `read-buffer.ts` separates *"0 bytes because we hold no buffer
 * for this terminal"* from *"0 bytes because the terminal is quiet"*, and
 * `provider-brand.ts` gives only three of twenty-one providers a mark because
 * *"borrowing another vendor's mark would assert a relationship that does not
 * exist."* Same discipline, now applied to an agent's state.
 */

const session = (over: Partial<AgentSession> = {}): AgentSession => ({
    ...emptyAgentSession({ agentId: 'a1', specId: 's1', provider: 'claude', name: 'kai', cwd: '/w', workspaceId: 'w1' }),
    ...over,
});

describe('emptyAgentSession', () => {
    it('starts at idle with nothing claimed', () => {
        const s = emptyAgentSession({
            agentId: 'a1',
            specId: 's1',
            provider: 'claude',
            name: 'kai',
            cwd: '/w',
            workspaceId: 'w1',
        });
        expect(s.agentId).toBe('a1');
        expect(s.specId).toBe('s1');
        expect(s.session).toEqual({
            provider: 'claude',
            name: 'kai',
            cwd: '/w',
            workspaceId: 'w1',
            sessionId: null,
        });
        expect(s.turn.state).toBe('idle');
        expect(s.transcript).toEqual([]);
        expect(s.live).toBeNull();
        expect(s.error).toBeNull();
    });

    it('defaults the UNKNOWABLE to null, not to an empty value', () => {
        // This is the rule. A pty agent has a composer, a plan, a cost and a set
        // of slash commands — Genie simply cannot see any of them. `null` says
        // "not visible"; `[]` would claim "the agent has none" and `0` would
        // claim "it has spent nothing", both of which are assertions we have no
        // standing to make.
        const s = emptyAgentSession({
            agentId: 'a1',
            specId: 's1',
            provider: 'aider',
            name: 'rook',
            cwd: '/w',
            workspaceId: 'w1',
        });
        expect(s.composer).toBeNull();
        expect(s.plan).toBeNull();
        expect(s.usage).toBeNull();
        expect(s.commands).toBeNull();
    });

    it('defaults the KNOWABLE to empty, because Genie owns those', () => {
        // Approvals and tools are different: Genie's own ForceTheQuestion queue
        // and its own pulse are the source, so "none pending" is a fact it can
        // state for any provider.
        const s = emptyAgentSession({
            agentId: 'a1',
            specId: 's1',
            provider: 'aider',
            name: 'rook',
            cwd: '/w',
            workspaceId: 'w1',
        });
        expect(s.approvals).toEqual([]);
        expect(s.tools).toEqual([]);
    });

    it('is a fresh object each time', () => {
        const a = emptyAgentSession({ agentId: 'a1', specId: 's1', provider: 'claude', name: 'k', cwd: '/w', workspaceId: null });
        const b = emptyAgentSession({ agentId: 'a2', specId: 's2', provider: 'claude', name: 'k', cwd: '/w', workspaceId: null });
        a.transcript.push({ id: 'm1', role: 'user', content: 'hi' });
        expect(b.transcript).toEqual([]);
    });
});

describe('sessionFidelity', () => {
    it('is observed when Genie can only watch', () => {
        expect(sessionFidelity(session())).toBe('observed');
    });

    it('is declared once the agent has stated its own composer', () => {
        // The composer is the right discriminator: it is the one field no
        // observer can ever infer. `draft.ts` reconstructs a guess from the
        // keystrokes Genie itself sent and says so in its own doc — *"Genie
        // cannot read a TUI's input box"*. So a present composer means the
        // agent told us, which means the rest of the report is trustworthy too.
        expect(sessionFidelity(session({ composer: { text: '', cursor: 0, busy: false } }))).toBe('declared');
    });

    /**
     * ACP has NO COMPOSER, and keying fidelity on one locked it out.
     *
     * `composer` was the right discriminator for `reportState`, the genie-tui producer,
     * which does report an input box. An ACP agent cannot: it has no idea what the human is
     * typing, so `applySessionUpdate` never sets one. An ACP session would therefore have
     * been classified `observed` forever — showing the Terminal-first tab set and hiding the
     * Conversation tab — no matter how much declared data arrived.
     *
     * So the test is "did something no observer could have produced arrive". Measured, the
     * floor projector assigns exactly four fields — `turn`, `transcript`, `approvals`,
     * `error` — and leaves `composer`, `plan`, `usage` and `commands` null. Any of those
     * four is proof of a declaration, whichever producer sent it.
     */
    it('is declared when the agent states its PLAN, which no observer can infer', () => {
        expect(sessionFidelity(session({ plan: [] }))).toBe('declared');
    });

    it('is declared when the agent states its USAGE', () => {
        // Cost and context come from `usage_update`. Genie cannot watch a pty and learn
        // either, which is why a pty agent's cost cell renders nothing at all.
        expect(
            sessionFidelity(session({ usage: { contextUsed: 1000, contextMax: 200_000, costUsd: 0.1 } })),
        ).toBe('declared');
    });

    it('is declared when the agent offers its own SLASH COMMANDS', () => {
        // `available_commands_update`. Today a human has to KNOW an agent's commands; a
        // declaring agent hands over the list, and nothing else can.
        expect(sessionFidelity(session({ commands: [] }))).toBe('declared');
    });

    it('treats an EMPTY declared value as a declaration, not as absence', () => {
        // The asymmetry `knownFacts` already documents: `plan: []` means the agent said it
        // has no plan; `plan: null` means we cannot say. The first is a declaration.
        expect(sessionFidelity(session({ plan: [] }))).toBe('declared');
        expect(sessionFidelity(session({ plan: null }))).toBe('observed');
    });

    it('is unknown when the provider could not be resolved', () => {
        // Not the same as observed. Observed means "running, and we can see
        // activity"; unknown means "we cannot even say what this is", which the
        // UI must offer a repair for rather than an empty transcript.
        expect(sessionFidelity(session({ session: { ...session().session, provider: null } }))).toBe('unknown');
    });

    it('does not mistake a transcript for a declaration', () => {
        // The floor projector fills `transcript` for EVERY provider out of the
        // AgentInbox thread and the last handoff note. If a transcript implied
        // declared fidelity, every pty agent would claim to be showing its
        // conversation while showing its mail.
        expect(sessionFidelity(session({ transcript: [{ id: 'm1', role: 'agent', content: 'done' }] }))).toBe(
            'observed',
        );
    });
});

describe('knownFacts', () => {
    it('reports which fields the UI may render', () => {
        expect(knownFacts(session())).toEqual({
            composer: false,
            plan: false,
            usage: false,
            commands: false,
            transcript: false,
        });
    });

    it('counts an EMPTY declared value as known', () => {
        // `plan: []` is a real answer — the agent has no plan right now — and the
        // UI should render "no plan" rather than hiding the section as it does
        // when the value is unknowable.
        expect(knownFacts(session({ plan: [] })).plan).toBe(true);
        expect(knownFacts(session({ commands: [] })).commands).toBe(true);
    });

    it('counts a non-empty transcript as known', () => {
        expect(knownFacts(session({ transcript: [{ id: 'm', role: 'user', content: 'x' }] })).transcript).toBe(true);
    });

    it('reports usage known only when there is a figure', () => {
        expect(knownFacts(session({ usage: { contextUsed: 38_000, contextMax: 200_000, costUsd: null } })).usage).toBe(
            true,
        );
    });
});
