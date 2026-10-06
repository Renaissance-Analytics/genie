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
