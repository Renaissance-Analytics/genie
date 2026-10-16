import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { turnStopOffered } from '../src/core/agent-view.js';
import { chatMessages } from '../src/core/chat-view.js';
import type { AgentRow } from '../src/core/dashboard-view.js';
import type { LiveSession } from '../src/core/roster.js';
import { ledgerRow, type TimedEvent } from '../src/core/stream-view.js';
import { EMPTY_SNAPSHOT, NO_FILES, type GenieSnapshot } from '../src/renderer/bridge.js';
import { ChatFlyout } from '../src/renderer/components/ChatFlyout.js';
import { TurnStop } from '../src/renderer/components/TurnStop.js';
import { Shell } from '../src/renderer/Shell.js';

/**
 * ONE STOP, AND IT STOPS THE TURN (the owner, 2026-10-15: "I hit the stop button at the bottom that appears under the
 * send button (bad UX btw) but it killed the agent, not stopping the chat").
 *
 *  - `Stop this turn` sits with the running turn — the chat's context line, the Agent view's state pill — not under Send.
 *  - It is offered only when the agent's driver can end a turn and keep the agent (`LiveSession.cancelTurn`). A driver
 *    that cannot, or an unknown one, gets no composer Stop at all; "Stop agent" in the operations menu ends the agent.
 *  - The stopped turn says so: `Stopped by you`, in the ledger and in the chat.
 *
 * The press is counted on the button itself (hook-free, no DOM); the chain behind it — cancel once, stop never — is
 * counted in test/stop-cancels-turn.test.ts and test/host-api.test.ts.
 */

function row(over: Partial<AgentRow>): AgentRow {
    return { id: 'x', name: 'x', provider: 'claude', workspaceId: 'ws_beta', fidelity: 'declared', state: 'working', duration: null, ask: null, reason: null, fixes: [], step: null, target: null, activity: null, delivery: null, collaborators: null, commsAgeSeconds: null, contextUsed: null, contextSize: null, ...over };
}
const agents: AgentRow[] = [row({ id: 'a_lark', name: 'lark' })];
const workspaces = [{ id: 'ws_beta', path: '/w/beta', name: 'beta.example', agentsKnown: true }];
const working = (over: Partial<LiveSession> = {}): LiveSession => ({
    running: true, turnState: 'working', startedAt: 1_000, pendingApproval: null, failure: null,
    contextUsed: null, contextSize: null, lastDelivery: null, collaborators: null, commsAgeSeconds: null, plan: null, ...over,
});
const count = (html: string, needle: string): number => html.split(needle).length - 1;

function shell(chatSession: LiveSession | null): string {
    const snapshot: GenieSnapshot = { ...EMPTY_SNAPSHOT, agents, workspaces };
    const lark = { agentId: 'a_lark', name: 'lark', fidelity: 'declared' as const, unread: null, messages: [], context: { text: 'Working', tone: 'ok' as const } };
    return renderToStaticMarkup(
        <Shell
            route="genie://workspace/ws_beta?chat=a_lark"
            snapshot={snapshot}
            servable={['dashboard', 'deck', 'agent', 'workspace']}
            agentDetail={null}
            agentResolved={false}
            selectedRowId={null}
            chatThread={lark}
            chatSession={chatSession}
            pinned={null}
            files={NO_FILES}
            onNavigate={() => {}}
            onOpenAgent={() => {}}
            onAddAgent={() => {}}
            onAddWorkspace={() => {}}
            onOpenPalette={() => {}}
            onSelectRow={() => {}}
            onSend={() => {}}
            onTogglePin={() => {}}
            onToggleFilesPin={() => {}}
            onCloseChat={() => {}}
            answeringApproval={null}
            onAnswerApproval={() => {}}
            onAnswerDeckItem={() => {}}
            onStopAgent={() => {}}
            onCancelTurn={() => {}}
        />,
    );
}

/** Every element in a hook-free component's output, depth first — so a test can press a button without a DOM. */
function elements(node: ReactNode): ReactElement<Record<string, unknown>>[] {
    if (Array.isArray(node)) return node.flatMap(elements);
    if (!isValidElement(node)) return [];
    const el = node as ReactElement<Record<string, unknown>>;
    return [el, ...elements(el.props.children as ReactNode)];
}

describe('the chat’s Stop', () => {
    it('a driver WITHOUT a turn cancel: no Stop in the chat at all — neither the turn’s nor the old one under Send', () => {
        const html = shell(working({ cancelTurn: false }));
        expect(count(html, 'data-action="stop-turn"')).toBe(0);
        expect(count(html, 'data-action="chat-stop"')).toBe(0);
        // Unknown (an older host sends no cancelTurn) is not "yes" either.
        expect(count(shell(working()), 'data-action="stop-turn"')).toBe(0);
        expect(count(shell(working()), 'data-action="chat-stop"')).toBe(0);
    });

    it('POSITIVE CONTROL: the same working agent whose driver CAN cancel gets exactly one `Stop this turn`, on the context line', () => {
        const html = shell(working({ cancelTurn: true }));
        expect(count(html, 'data-action="stop-turn"')).toBe(1);
        expect(count(html, 'data-action="chat-stop"')).toBe(0);
        const line = html.slice(html.indexOf('data-chat-context='), html.indexOf('data-chat-scroll'));
        expect(count(line, 'data-action="stop-turn"')).toBe(1);
        // Between turns there is nothing to stop.
        expect(count(shell(working({ cancelTurn: true, turnState: 'idle' })), 'data-action="stop-turn"')).toBe(0);
    });

    it('the button says what it does and pressing it asks ONCE — it carries no other action', () => {
        let stops = 0;
        const button = elements(TurnStop({ onStop: () => { stops += 1; }, agentName: 'lark' })).filter((e) => e.type === 'button');
        expect(button).toHaveLength(1);
        expect(button[0]!.props['data-action']).toBe('stop-turn');
        expect(button[0]!.props['title']).toBe('Stop this turn — lark keeps running');
        (button[0]!.props['onClick'] as () => void)();
        expect(stops).toBe(1);
        expect(renderToStaticMarkup(<TurnStop onStop={() => {}} />)).toContain('Stop this turn');
    });

    it('turnStopOffered: a running, unbroken, working turn on a driver that can cancel — and nothing else', () => {
        expect(turnStopOffered(working({ cancelTurn: true }))).toBe(true);
        expect(turnStopOffered(working({ cancelTurn: false }))).toBe(false);
        expect(turnStopOffered(working())).toBe(false);
        expect(turnStopOffered(working({ cancelTurn: true, turnState: 'idle' }))).toBe(false);
        expect(turnStopOffered(working({ cancelTurn: true, running: false }))).toBe(false);
        expect(turnStopOffered(working({ cancelTurn: true, failure: { reason: 'stream closed', fixes: [] } }))).toBe(false);
        expect(turnStopOffered(null)).toBe(false);
    });
});

describe('a stopped turn says so, plainly', () => {
    const rows: TimedEvent[] = [
        { id: 'r1', at: 1_000, event: { kind: 'message', speaker: 'you', peerName: null, text: 'refactor the queue worker' } },
        { id: 'r2', at: 2_000, event: { kind: 'message', speaker: 'agent', peerName: null, text: 'Starting with the' } },
        { id: 'r3', at: 3_000, event: { kind: 'stopped', n: 4, by: 'you' } },
    ];

    it('the ledger row reads `Stopped by you`; nobody asking reads `Stopped`', () => {
        expect(ledgerRow(rows[2]!).main).toBe('Stopped by you');
        expect(ledgerRow(rows[2]!).kind).toBe('stopped');
        expect(ledgerRow({ id: 'r4', at: null, event: { kind: 'stopped', n: 5, by: null } }).main).toBe('Stopped');
    });

    it('the chat shows ONE stopped line where the reply ends — after the cut-short reply, as its own row', () => {
        const messages = chatMessages({ agent: { id: 'a_lark', name: 'lark', provider: 'claude', fidelity: 'declared' }, session: null, rows });
        expect(messages.map((m) => m.who)).toEqual(['you', 'agent', 'stopped']);
        expect(messages[2]).toMatchObject({ id: 'r3', text: 'Stopped by you', at: 3_000 });
        const html = renderToStaticMarkup(<ChatFlyout thread={{ agentId: 'a_lark', name: 'lark', fidelity: 'declared', unread: null, messages }} pinned={false} onSend={() => {}} onClose={() => {}} />);
        expect(count(html, 'data-who="stopped"')).toBe(1);
        expect(html).toMatch(/data-who="stopped"[^]*Stopped by you/);
        // Control: the reply it cut short is still the agent's, by name.
        expect(count(html, 'data-who="agent"')).toBe(1);
    });
});
