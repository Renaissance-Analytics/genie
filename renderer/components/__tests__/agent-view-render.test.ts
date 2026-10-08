import { describe, expect, it } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AgentView } from '../Master/AgentView';
import type { AgentSession } from '../../../main/agentsession/model';

/**
 * That the Agent view RENDERS, and renders the right shape.
 *
 * A typecheck cannot catch a Fancy component that accepts a prop and shows nothing —
 * genie#320 is exactly that: `<Modal title=…>` type-checked and rendered no header, because
 * these components spread `HTMLAttributes` and silently swallow what they do not know. So
 * the markup is asserted, not just the types.
 */

const NOW = 1_000_000;

const session = (over: Partial<AgentSession> = {}): AgentSession => ({
    agentId: 'a1',
    specId: 's1',
    session: { provider: 'claude', name: 'kai', cwd: 'repos/genie', workspaceId: 'w1', sessionId: 'sess' },
    turn: { state: 'idle', since: NOW },
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

const declared = (over: Partial<AgentSession> = {}) =>
    session({ composer: { text: '', cursor: 0, busy: false }, ...over });

const render = (s: AgentSession, props: Record<string, unknown> = {}) =>
    renderToStaticMarkup(React.createElement(AgentView, { session: s, now: NOW, ...props }));

describe('the header says who and what', () => {
    it('names the agent, its provider and its cwd', () => {
        const html = render(declared());
        expect(html).toContain('kai');
        expect(html).toContain('claude');
        expect(html).toContain('repos/genie');
    });

    it('renders nothing for an unresolved provider rather than a placeholder', () => {
        const html = render(session({ session: { ...session().session, provider: null } }));
        expect(html).not.toContain('null');
        expect(html).not.toContain('undefined');
    });
});

describe('tabs follow fidelity, in the MARKUP', () => {
    it('a declared agent shows Conversation', () => {
        expect(render(declared())).toContain('Conversation');
    });

    it('an observed agent does NOT — absence, not a disabled tab', () => {
        const html = render(session());
        expect(html).not.toContain('Conversation');
        expect(html).toContain('Activity');
        // And nothing is disabled: a greyed control would be an accusation.
        expect(html).not.toContain('disabled');
    });
});

describe('a parked approval', () => {
    const parked = declared({
        turn: { state: 'awaiting-approval', since: NOW - 8_000 },
        approvals: [{ id: 'ap1', name: 'Write main/terminal/ipc.ts', args: {} }],
    });

    it('is INLINE with all three decisions, not a modal', () => {
        const html = render(parked);
        expect(html).toContain('Write main/terminal/ipc.ts');
        expect(html).toContain('Allow');
        expect(html).toContain('Allow for session');
        expect(html).toContain('Deny');
    });

    it('says the turn is parked, and for how long', () => {
        // The turn has STOPPED and the human is the bottleneck. That is the whole reason
        // this is inline rather than behind a modal.
        expect(render(parked)).toContain('turn parked');
        expect(render(parked)).toContain('8s');
    });

    it('shows no approval UI when merely thinking', () => {
        expect(render(declared({ turn: { state: 'thinking', since: NOW } }))).not.toContain('turn parked');
    });
});

describe('rails render only KNOWN facts', () => {
    it('omits the plan rail entirely when the agent cannot report one', () => {
        expect(render(session())).not.toContain('rail-plan');
    });

    it('shows the plan rail with a done count', () => {
        const html = render(
            declared({
                plan: [
                    { id: 'p1', title: 'read ipc.ts', status: 'done' },
                    { id: 'p2', title: 'patch it', status: 'in-progress' },
                ],
            }),
        );
        expect(html).toContain('rail-plan');
        expect(html).toContain('1/2');
        expect(html).toContain('patch it');
    });

    it('omits usage when unknown, so nothing can read as zero', () => {
        // A dash in a cost cell reads as zero. The cell is absent instead.
        const html = render(session());
        expect(html).not.toContain('rail-usage');
        expect(html).not.toContain('ctx ');
    });

    it('puts CONTEXT before cost, because context predicts the agent getting worse', () => {
        const html = render(
            declared({ usage: { contextUsed: 178_000, contextMax: 200_000, costUsd: 1.84 } }),
        );
        expect(html).toContain('rail-usage');
        expect(html.indexOf('178000')).toBeLessThan(html.indexOf('1.84'));
    });

    it('surfaces an error when there is one', () => {
        expect(render(declared({ error: 'the plan tool was not recognised' }))).toContain('rail-error');
    });
});

describe('subscription headroom is ON SCREEN', () => {
    /**
     * The owner's own measure of this migration: *"I do need to see what is remaining on rate
     * limits at least."*
     *
     * `rate-limit.ts` computed it and `rate-limit-view.ts` shapes it, both tested — and for a
     * while nothing RENDERED either, which is the gap a green suite reports as finished. These
     * cases assert the markup, because that is the part the owner can actually read.
     */
    const limited = (over: Record<string, unknown> = {}) =>
        declared({
            rateLimit: {
                status: 'allowed',
                rateLimitType: 'five_hour',
                windows: { five_hour: { utilization: 0.13, resetsAtMs: NOW + 3_600_000 } },
                notice: null,
                ...over,
            } as never,
        });

    it('shows what is LEFT and when it resets', () => {
        const html = render(limited());
        expect(html).toContain('87% left');
        expect(html).toContain('resets in 1h');
        expect(html).toContain('5h');
    });

    it('shows NOTHING for an agent that reports no limit', () => {
        // Every pty agent. A gauge at 100% for an agent nobody is metering is the single most
        // expensive thing this could get wrong — it is the number a day of work gets planned
        // around.
        const html = render(declared());
        expect(html).not.toContain('left');
        expect(html).not.toContain('rail-ratelimit');
    });

    it('marks the TONE so a thin window is visibly different from a full one', () => {
        expect(render(limited())).toContain('data-tone="ok"');
        expect(
            render(
                limited({ windows: { five_hour: { utilization: 0.93, resetsAtMs: NOW + 600_000 } } }),
            ),
        ).toContain('data-tone="warn"');
    });

    it('says rate LIMITED rather than a cheerful percentage', () => {
        const html = render(limited({ status: 'rate_limited' }));
        expect(html).toContain('rate limited');
        expect(html).not.toContain('87% left');
    });

    it('renders WHY there is no reading, when that is all there is', () => {
        const html = render(declared({ rateLimitUnavailable: 'unmapped frame: rate_limit_event' }));
        expect(html).toContain('no reading');
        expect(html).toContain('unmapped frame: rate_limit_event');
    });
});

describe('the Conversation can be TALKED TO', () => {
    /**
     * The gap this closes, measured rather than assumed: `agentSession` over IPC was `list()`,
     * `master.tsx` passed neither `onApprove` nor `onTakeOver`, and the Conversation tab had no
     * input at all. `terminal:write` reaches a pty — and an ACP agent's pty is an empty shell.
     *
     * So the default surface of Genie 2 could display an agent and not speak to it. Everything
     * type-checked and the suite was green, because nothing asserted that a human could act.
     */
    it('offers a composer on the Conversation tab', () => {
        expect(render(declared(), { onSend: () => {} })).toContain('agent-composer');
    });

    it('does NOT offer one without a send handler', () => {
        // A box that cannot send is worse than no box: it invites typing and swallows it.
        expect(render(declared())).not.toContain('agent-composer');
    });

    it('offers no composer for an OBSERVED agent, which has a Terminal tab instead', () => {
        // A pty agent is driven by typing into its TUI. A second input that cannot reach it
        // would be two ways to do one thing, one of which silently fails.
        const html = render(session(), { onSend: () => {} });
        expect(html).not.toContain('agent-composer');
    });

    it('offers STOP while a turn is running, and not while it is idle', () => {
        // `session/cancel` only ASKS, so the control is honest about what it does — but it has
        // to exist: a turn you cannot stop is the thing people take over the terminal for.
        const working = declared({ turn: { state: 'thinking', since: NOW - 5_000 } });
        expect(render(working, { onSend: () => {}, onCancel: () => {} })).toContain('agent-stop');
        expect(render(declared(), { onSend: () => {}, onCancel: () => {} })).not.toContain('agent-stop');
    });

    it('keeps the approval card to THREE decisions, with a handler behind them', () => {
        // The shape is pinned elsewhere in this file ("is INLINE with all three decisions, not a
        // modal") and that decision stands. An earlier version of this case hid the buttons when
        // no handler was passed, which contradicted it and encoded a rule nobody asked for — the
        // real requirement is that the handler EXISTS in the product, which is the
        // `master.tsx` wiring (`agentSession.decide`), not a prop check.
        const parked = declared({
            approvals: [{ id: 'p1', name: 'Edit ipc.ts', args: {} }],
            turn: { state: 'awaiting-approval', since: NOW - 1_000 },
        });
        const html = render(parked, { onApprove: () => {} });
        expect(html).toContain('Edit ipc.ts');
        expect(html).toContain('Allow');
        expect(html).toContain('Allow for session');
        expect(html).toContain('Deny');
    });
});

/**
 * WHO SAID IT — P7 folds human<->agent DMs into this surface, and a DM thread is MULTI-PARTY.
 *
 * `mergeDeclared` now interleaves the floor's AgentInbox thread with the declared session
 * instead of replacing it, because a measured ACP session reports the agent's voice and nothing
 * else. So the Conversation carries three speakers where it used to carry two: the agent, the
 * owner, and a SIBLING AGENT that messaged this one.
 *
 * `Message.author` exists for precisely that -- *"a message from a sibling agent is neither this
 * agent speaking nor the owner speaking... encoding the sender into `content` as a prefix would
 * be munging somebody's text, so it gets a field"*. The view rendered `m.role` and dropped it,
 * which labels another agent's message "user" and makes it read as the owner's own instruction.
 * On a surface whose whole job is deciding what to do next, that is the worst possible confusion.
 */
describe('the Conversation says WHO, not just what role', () => {
    /**
     * The author NAME shares no substring with any message body, and that is deliberate: the
     * first draft of these tests used an author of `prism` alongside the text *"prism-acp 0.5.0
     * is up"*, so `toContain('prism')` passed against the UNCHANGED view. A test that cannot
     * tell the fix from its absence is worse than no test, because it reads as covered.
     */
    const SIBLING = 'kora';
    const thread = () =>
        declared({
            transcript: [
                { id: 'm1', role: 'user', author: null, content: 'start on the lists dock', at: NOW },
                { id: 'm2', role: 'user', author: SIBLING, content: 'the adapter release is up', at: NOW + 1 },
                { id: 'd1', role: 'agent', author: null, content: 'installing it', at: NOW + 2 },
            ],
        });

    /** The `agent-msg-who` labels, in order, with no message bodies in the way. */
    const whoLabels = (html: string): string[] =>
        [...html.matchAll(/class="[^"]*agent-msg-who[^"]*"[^>]*>([^<]*)</g)].map((m) => m[1]!);

    it('NAMES a sibling agent that sent a DM', () => {
        expect(whoLabels(render(thread()))).toContain(SIBLING);
    });

    it('does not label another agent\'s message as the owner', () => {
        // The failure mode as an assertion: before this, all three rows read role-only, so the
        // sibling's row said "user" -- the same word as the owner's -- and another agent's
        // request became indistinguishable from an instruction from the person in charge.
        const labels = whoLabels(render(thread()));
        expect(labels).toHaveLength(3);
        expect(labels.filter((l) => l === SIBLING)).toHaveLength(1);
        expect(labels.filter((l) => l === 'user')).toHaveLength(0);
    });

    it('labels the owner and the agent plainly, having no author to name', () => {
        const labels = whoLabels(render(thread()));
        expect(labels[0]).toBe('you');
        expect(labels[2]).toBe('agent');
    });

    it('still labels a tool or error row by its role', () => {
        // `author` is null for these and there is nobody to name; the role IS the answer.
        const labels = whoLabels(
            render(declared({ transcript: [{ id: 'e1', role: 'error', content: 'host lost', at: NOW }] })),
        );
        expect(labels).toEqual(['error']);
    });
});
