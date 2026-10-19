import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { AgentRow } from '../src/core/dashboard-view.js';
import { chatThreadFrom } from '../src/core/chat-view.js';
import type { AgentDetail } from '../src/renderer/bridge.js';
import { ChatFlyout } from '../src/renderer/components/ChatFlyout.js';

/**
 * THE CHAT NEVER CLOSES — AND IT SHOWS ITS CONVERSATION ON EVERY PAGE (the owner, 2026-10-19, after saying it three
 * times: "THE CHAT DOES NOT EVER FUCKING CLOSE"). #974 made the chat's SUBJECT permanent (the route's `chat=`, else the
 * agent the view says), but the conversation was still LOADED for the route's `chat=` only: every page reached without
 * it — the Command Window, Settings, the Dashboard, a workspace picked from the palette — showed the subject with no
 * messages and no context line, which reads as a closed chat. And a detail loaded for another agent was drawn under the
 * subject's name.
 *
 * The thread is the subject's or nothing: a detail of another agent is not used, and the flyout says whether the
 * conversation is loaded (`data-chat-loaded`), which the real-window smoke reads on a page reached without `chat=`.
 */
const T = 1_700_000_000_000;
const rowOf = (id: string, name: string): AgentRow => ({
    id, name, provider: 'claude', workspaceId: 'tynn', fidelity: 'declared', state: 'idle', duration: null, ask: null, reason: null, fixes: [],
    step: null, target: null, activity: null, delivery: null, collaborators: null, commsAgeSeconds: null, contextUsed: null, contextSize: null,
});
const rows = [rowOf('g1', 'genie'), rowOf('a1', 'atlas')];
const detailOf = (id: string, name: string, text: string): AgentDetail => ({
    agent: { id, name, provider: 'claude', fidelity: 'declared', cwd: '/w' },
    session: null, turns: 0, cost: null, refusal: null,
    rows: [{ id: `${id}-e1`, event: { kind: 'message', speaker: 'agent', peerName: null, text }, at: T }],
});

describe('chatThreadFrom — the subject’s conversation or none', () => {
    it("the subject's own detail: its messages, and loaded", () => {
        const thread = chatThreadFrom(detailOf('g1', 'genie', 'Hello from genie'), 'g1', rows, () => T);
        expect(thread.loaded).toBe(true);
        expect(thread.messages.map((m) => m.id)).toEqual(['g1-e1']);
    });

    it("ANOTHER agent's detail is not drawn under the subject's name — no messages, not loaded", () => {
        const thread = chatThreadFrom(detailOf('a1', 'atlas', 'atlas speaking'), 'g1', rows, () => T);
        expect(thread.name).toBe('genie');
        expect(thread.messages).toEqual([]);
        expect(thread.context).toBeNull();
        expect(thread.loaded).toBe(false);
    });

    it('no detail yet: the subject, not loaded', () => {
        expect(chatThreadFrom(null, 'g1', rows, () => T)).toMatchObject({ agentId: 'g1', name: 'genie', loaded: false, messages: [] });
    });
});

describe('the flyout says whether its conversation is loaded', () => {
    const render = (thread: ReturnType<typeof chatThreadFrom>) =>
        renderToStaticMarkup(<ChatFlyout thread={thread} onSend={() => {}} scope={{ kind: 'here' }} />);

    it('loaded: data-chat-loaded="true"; not yet: "false" (COUNTED, one chat)', () => {
        const loaded = render(chatThreadFrom(detailOf('g1', 'genie', 'Hi'), 'g1', rows, () => T));
        expect((loaded.match(/data-chat-loaded="/g) ?? []).length).toBe(1);
        expect(loaded).toContain('data-chat-loaded="true"');
        expect(render(chatThreadFrom(null, 'g1', rows, () => T))).toContain('data-chat-loaded="false"');
    });
});
