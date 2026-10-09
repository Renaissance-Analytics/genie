import { describe, expect, it } from 'vitest';
import { agentViewTabs, defaultTabFor, parkedApproval } from '../agent-view';
import { knownFacts } from '../../../main/agentsession/model';
import type { AgentSession } from '../../../main/agentsession/model';

/**
 * The Agent view's shape, decided by FIDELITY — Genie 2's most important screen.
 *
 * The rule, from the approved spec: **absence of a tab, not a disabled tab.** A Declared
 * agent (one speaking a structured transport) can show a Conversation; an Observed one —
 * every pty provider — cannot, because Genie only sees bytes. So the Observed shape leads
 * with Terminal and offers Activity instead.
 *
 * Nothing is greyed out. *A disabled control is an accusation; a different shape is a
 * fact.* A greyed-out "Conversation" tells the user they did something wrong, when the
 * truth is that their provider does not report one.
 *
 * All of it is pure because the renderer's test environment has no DOM: a decision inside a
 * component is a decision nobody checks.
 */

const session = (over: Partial<AgentSession> = {}): AgentSession => ({
    agentId: 'a1',
    specId: 's1',
    session: { provider: 'claude', name: 'kai', cwd: '/w', workspaceId: 'w1', sessionId: 'sess' },
    turn: { state: 'idle', since: 0 },
    thoughts: [],
    liveThought: null,
    rateLimit: null,
    rateLimitUnavailable: null,
    composer: null,
    transcript: [],
    live: null,
    tools: [],
    approvals: [],
    plan: null,
    usage: null,
    commands: null,
    error: null,
    ...over,
});

/** Declared = the agent reports its own composer. Observed = it does not. */
const declared = (over: Partial<AgentSession> = {}) =>
    session({ composer: { text: '', cursor: 0, busy: false }, ...over });

describe('tabs follow fidelity', () => {
    it('a DECLARED agent leads with Conversation', () => {
        expect(agentViewTabs(declared())).toEqual(['session', 'files', 'changes']);
        expect(defaultTabFor(declared())).toBe('session');
    });

    it('an OBSERVED agent has NO Conversation tab at all, and leads with Activity', () => {
        // Not disabled — absent. Genie cannot see inside a TUI, so there is no conversation
        // to show, and claiming otherwise with a dead tab would be a lie in UI form.
        const tabs = agentViewTabs(session());
        expect(tabs).not.toContain('session');
        expect(tabs).toEqual(['activity', 'files', 'changes']);
        expect(defaultTabFor(session())).toBe('activity');
    });

    it('an UNKNOWN provider still gets Activity, because bytes always work', () => {
        // `provider: null` means Genie could not resolve what this is. It can still MEASURE
        // the pty's output, so the window stays useful; pretending otherwise would strand
        // the user. What it must not do is claim a conversation it cannot see.
        const unknown = session({ session: { ...session().session, provider: null } });
        expect(agentViewTabs(unknown)).toContain('activity');
        expect(defaultTabFor(unknown)).toBe('activity');
    });

    /**
     * THE TERMINAL IS NOT A TAB ANYWHERE — owner's ruling, 2026-10-08:
     *
     *   "The new UX needs the ability to open an agent in a provider TUI but that opens in
     *    a new window, not in theFloor. the only terminal like ux in the floor is when
     *    watching an agents workstream (firehose layout) which isn't a real terminal."
     *
     * So a pty never mounts inside the Floor. `terminals.openWindow({ kind: 'agent' })`
     * (Tynn #447) is the one way to one, and the Floor's terminal-shaped surface is the
     * Stream for a Declared agent and Activity for an Observed one — both rendered from
     * reported facts, neither an xterm.
     *
     * Asserted across EVERY shape rather than on one sample: a tab list that quietly keeps
     * `terminal` for the unknown case is exactly the kind of leftover that survives a
     * migration, and it would put a live pty back on the Floor.
     */
    it('never offers a Terminal tab, in any shape', () => {
        const unknown = session({ session: { ...session().session, provider: null } });
        for (const s of [declared(), session(), unknown]) {
            expect(agentViewTabs(s)).not.toContain('terminal');
            expect(defaultTabFor(s)).not.toBe('terminal');
        }
    });

    it('never offers Activity to a Declared agent', () => {
        // Activity is a sparkline — a MEASUREMENT, for when there are no declared facts.
        // Offering both would present a guess beside the truth as though they were peers.
        expect(agentViewTabs(declared())).not.toContain('activity');
    });
});

describe('rails show only what is KNOWN — via the model knownFacts, not a second copy of the rule', () => {
    it('hides the plan rail when the agent cannot report one', () => {
        // `plan: null` means "cannot see", NOT "no plan". An empty rail would say the agent
        // has nothing planned, which is a claim about the agent rather than about us.
        expect(knownFacts(session()).plan).toBe(false);
    });

    it('SHOWS the plan rail when the agent reports an empty plan', () => {
        // `[]` is a fact: the agent has no plan right now. That is worth showing, because
        // it differs from not knowing.
        expect(knownFacts(declared({ plan: [] })).plan).toBe(true);
    });

    it('hides usage when unknown, so no cell can read as zero', () => {
        // Never render a dash in a cost or context cell — a dash reads as zero.
        expect(knownFacts(session()).usage).toBe(false);
        expect(knownFacts(declared({ usage: { contextUsed: 1, contextMax: 2, costUsd: 0 } })).usage).toBe(true);
    });

    it('hides commands when unknown, which is codex today', () => {
        // Codex exposes no slash-command list at all, so `null` is the honest value and the
        // rail must not say "this agent has no commands".
        expect(knownFacts(session()).commands).toBe(false);
        expect(knownFacts(declared({ commands: [] })).commands).toBe(true);
    });
});

describe('a parked turn', () => {
    it('is reported when an approval is waiting', () => {
        // The turn has STOPPED and the human is the bottleneck. Saying so is the whole
        // reason approvals are inline rather than in a modal.
        const s = declared({
            turn: { state: 'awaiting-approval', since: 1_000 },
            approvals: [{ id: 'ap1', name: 'Write', args: {} }],
        });
        expect(parkedApproval(s)).toMatchObject({ id: 'ap1', name: 'Write' });
    });

    it('is NOT reported when the agent is merely thinking', () => {
        expect(parkedApproval(declared({ turn: { state: 'thinking', since: 0 } }))).toBeNull();
    });

    it('is not reported when the state says awaiting-approval but no approval arrived', () => {
        // The states disagree. Showing a parked banner with nothing to click would leave
        // the user stuck with no action — worse than showing nothing and letting the
        // transcript speak.
        expect(parkedApproval(declared({ turn: { state: 'awaiting-approval', since: 0 } }))).toBeNull();
    });
});
