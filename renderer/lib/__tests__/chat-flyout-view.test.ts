import { describe, expect, it } from 'vitest';
import { emptyAgentSession, type AgentSession } from '../../../main/agentsession/model';
import { chatFlyoutView, CHAT_DOCK_WIDTH } from '../chat-flyout-view';

/**
 * THE CHAT FLYOUT's own decisions — §5.4 of the owner's spec board.
 *
 * It replaces the Agent view's composer, so it is the only place a human types to an agent.
 * That makes its refusals load-bearing: what it says about an agent it cannot hear from is the
 * difference between "nobody replied" and "this provider does not report replies".
 *
 * Pure, so the wording and the states are testable without rendering. The component is the
 * render only — the same split as `deck-view` and `dashboard-view`.
 */

const NOW = 1_000_000;

function session(over: Partial<AgentSession> & { agentId: string }): AgentSession {
    const base = emptyAgentSession(
        {
            agentId: over.agentId,
            specId: `spec-${over.agentId}`,
            provider: 'claude',
            name: over.agentId,
            cwd: '/w',
            workspaceId: 'tynn',
        },
        NOW,
    );
    return { ...base, ...over, session: { ...base.session, ...(over.session ?? {}) } };
}

describe('the context line — one line saying what this agent is doing', () => {
    it('names the plan step and the target while working', () => {
        // The board: `Working · Plan 4/7 · Passkey enrolment endpoint`. The target is what
        // makes the line worth reading — "Working" alone is what the dot already said.
        const v = chatFlyoutView({
            session: session({
                agentId: 'atlas',
                turn: { state: 'tool', since: NOW - 60_000 },
                plan: [
                    { id: '1', title: 'a', status: 'done' },
                    { id: '2', title: 'b', status: 'done' },
                    { id: '3', title: 'c', status: 'done' },
                    { id: '4', title: 'Passkey enrolment endpoint', status: 'in-progress' },
                    { id: '5', title: 'e', status: 'pending' },
                    { id: '6', title: 'f', status: 'pending' },
                    { id: '7', title: 'g', status: 'pending' },
                ],
            }),
            now: NOW,
        });
        expect(v.contextLine).toBe('Working · Plan 4/7 · Passkey enrolment endpoint');
        expect(v.contextLevel).toBe('normal');
    });

    it('says PARKED, with how long, when the turn is waiting on a human', () => {
        /**
         * The board: `Parked · waiting on you for 2m 14s`, in amber. The duration is the point
         * — a parked turn costs nothing to leave parked, which is exactly why a person needs
         * to see that it has been two minutes rather than two seconds.
         */
        const v = chatFlyoutView({
            session: session({
                agentId: 'wren',
                turn: { state: 'awaiting-approval', since: NOW - 134_000 },
                approvals: [{ id: 'a1', name: 'Bash', args: {} }],
                plan: [],
            }),
            now: NOW,
        });
        expect(v.contextLine).toBe('Parked · waiting on you for 2m 14s');
        expect(v.contextLevel).toBe('attention');
    });

    it('says BROKEN with the reason, and that outranks the turn state', () => {
        const v = chatFlyoutView({
            session: session({
                agentId: 'lark',
                error: 'ACP stream closed · exit 137',
                turn: { state: 'tool', since: NOW },
                plan: [],
            }),
            now: NOW,
        });
        expect(v.contextLine).toBe('Broken · ACP stream closed · exit 137');
        expect(v.contextLevel).toBe('broken');
    });

    it('says OBSERVED and names the provider, so the thread explains itself', () => {
        // The board: `Observed · aider runs in a terminal`. This is the line that stops a
        // one-sided thread reading as an agent ignoring you.
        const v = chatFlyoutView({
            session: session({ agentId: 'moth', session: { provider: 'aider' } as AgentSession['session'] }),
            now: NOW,
        });
        expect(v.contextLine).toBe('Observed · aider runs in a terminal');
        expect(v.contextLevel).toBe('muted');
    });

    it('is just Idle when there is nothing else true', () => {
        const v = chatFlyoutView({
            session: session({ agentId: 'genie', turn: { state: 'idle', since: NOW }, plan: [] }),
            now: NOW,
        });
        expect(v.contextLine).toBe('Idle');
    });

    it('has no line at all with no agent selected', () => {
        // Not "Idle" — there is no subject to be idle. The empty state speaks instead.
        const v = chatFlyoutView({ session: null, now: NOW });
        expect(v.contextLine).toBeNull();
    });
});

describe('the composer tells the truth about where the text goes', () => {
    it('messages a declared agent', () => {
        const v = chatFlyoutView({ session: session({ agentId: 'atlas', plan: [] }), now: NOW });
        expect(v.placeholder).toBe('Message atlas');
        expect(v.sendLabel).toBe('Send');
    });

    it('says TERMINAL for an observed agent, in both the placeholder and the button', () => {
        /**
         * The board: placeholder *"Type into moth's terminal"*, button *"Send to terminal"*.
         *
         * This is §6.3 applied to a verb. The input is NOT withheld — the surfaces design makes
         * that case and it is right: withholding it removes the only way to nudge a pty agent.
         * But a button that says "Send" beside a thread that will never show a reply promises a
         * conversation. Saying "terminal" costs one word and removes the whole wrong model.
         */
        const v = chatFlyoutView({
            session: session({ agentId: 'moth', session: { provider: 'aider' } as AgentSession['session'] }),
            now: NOW,
        });
        expect(v.placeholder).toBe("Type into moth's terminal");
        expect(v.sendLabel).toBe('Send to terminal');
    });

    it('keeps a draft and says so when the agent is not running', () => {
        // The board's error state: *"Draft kept. Sends when lark is running."* The message is
        // never silently dropped — a lost instruction is worse than a visible failure.
        const v = chatFlyoutView({
            session: session({ agentId: 'lark', specId: null, error: 'ACP stream closed', plan: [] }),
            now: NOW,
        });
        expect(v.placeholder).toBe('Draft kept. Sends when lark is running.');
        expect(v.canSend).toBe(false);
    });

    it('can send to a dormant agent that is NOT broken, because sending wakes it', () => {
        // The positive control for the case above: `specId: null` alone must not disable the
        // composer, or every idle agent would look unreachable. Mail queues durably.
        const v = chatFlyoutView({ session: session({ agentId: 'fen', specId: null, plan: [] }), now: NOW });
        expect(v.canSend).toBe(true);
    });

    it('offers Stop only while a turn is actually running', () => {
        const running = chatFlyoutView({
            session: session({ agentId: 'a', turn: { state: 'tool', since: NOW }, plan: [] }),
            now: NOW,
        });
        const idle = chatFlyoutView({
            session: session({ agentId: 'a', turn: { state: 'idle', since: NOW }, plan: [] }),
            now: NOW,
        });
        const parked = chatFlyoutView({
            session: session({ agentId: 'a', turn: { state: 'awaiting-approval', since: NOW }, plan: [] }),
            now: NOW,
        });
        expect(running.canStop).toBe(true);
        expect(idle.canStop).toBe(false);
        // PARKED IS NOT RUNNING. A Stop button on a turn that is already waiting for you
        // suggests the agent is busy, when the thing it is waiting for is you.
        expect(parked.canStop).toBe(false);
    });
});

describe('what the thread says it cannot show you', () => {
    it('carries a note for an OBSERVED agent explaining the one-sidedness', () => {
        /**
         * The board's wording: *"aider does not report a conversation. What you send here is
         * typed into moth's terminal; its replies stay in the terminal."*
         *
         * Without it an empty thread is indistinguishable from an agent ignoring you — the
         * `null`-is-not-zero rule applied to a conversation.
         */
        const v = chatFlyoutView({
            session: session({ agentId: 'moth', session: { provider: 'aider' } as AgentSession['session'] }),
            now: NOW,
        });
        expect(v.oneSidedNote).toContain('aider does not report a conversation');
        expect(v.oneSidedNote).toContain('replies stay in the terminal');
    });

    it('carries NO note for a declared agent, because its replies do arrive', () => {
        // The positive control. A note on every thread would be noise, and §6.2 says a signal
        // that is always present stops being read.
        const v = chatFlyoutView({ session: session({ agentId: 'atlas', plan: [] }), now: NOW });
        expect(v.oneSidedNote).toBeNull();
    });

    it('names the provider it cannot hear from, rather than saying "this agent"', () => {
        // The repair is provider-shaped: a person who knows it is goose can decide to switch.
        const v = chatFlyoutView({
            session: session({ agentId: 'kite', session: { provider: 'goose' } as AgentSession['session'] }),
            now: NOW,
        });
        expect(v.oneSidedNote).toContain('goose');
    });
});

describe('the empty state', () => {
    it('explains what genie can reach rather than just saying there is nothing', () => {
        // The board: *"genie can reach any agent in any workspace. Name one with @, or pick a
        // thread above."* An empty surface that only reports emptiness teaches nothing.
        const v = chatFlyoutView({ session: null, now: NOW });
        expect(v.isEmpty).toBe(true);
        expect(v.emptyHint).toContain('@');
    });
});

describe('the pinned geometry', () => {
    it('reserves exactly the width the board specifies', () => {
        /**
         * 380px, and pinned it RESERVES rather than overlays — the rule this repo has shipped
         * wrong three times, most recently in genie#841 where the reserve named only the
         * hidden grid row. The number lives here so the component and the stylesheet cannot
         * disagree about it.
         */
        expect(CHAT_DOCK_WIDTH).toBe(380);
    });
});
