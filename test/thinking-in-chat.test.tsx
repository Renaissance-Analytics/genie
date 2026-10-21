import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { chatMessages, type ChatDetail } from '../src/core/chat-view.js';
import { ChatFlyout, type ChatThread } from '../src/renderer/components/ChatFlyout.js';

/**
 * THE AGENT'S THINKING SHOWS IN THE CHAT (beta.33 item 30, carried to beta.35; the owner, 2026-10-20: "the thinking
 * content should be posting in the chat stream, not the work stream"). A `think` row is a message in the chat, in its
 * order with the replies, from any provider that reports it — collapsed by default, opened with a click. Consecutive
 * thoughts (a provider streams them in pieces) are one; a thought with no words (redacted) is not shown as an empty one.
 */

const detail = (rows: ChatDetail['rows']): ChatDetail => ({ agent: { id: 'a1', name: 'lark', provider: 'claude', fidelity: 'declared' }, session: null, rows } as unknown as ChatDetail);
const think = (id: string, text: string, at: number) => ({ id, event: { kind: 'think', text, tokens: null, estimate: null }, at });
const say = (id: string, speaker: 'you' | 'agent', text: string, at: number) => ({ id, event: { kind: 'message', speaker, peerName: null, text }, at });

describe('the chat’s messages', () => {
    it('a thought is a message, in its order with the replies', () => {
        const messages = chatMessages(detail([
            say('r1', 'you', 'Why is the build red?', 1),
            think('r2', 'The CI log says the lockfile is stale.', 2),
            say('r3', 'agent', 'The lockfile is stale; I regenerated it.', 3),
        ] as never));
        expect(messages.map((m) => [m.who, m.text])).toEqual([
            ['you', 'Why is the build red?'],
            ['thinking', 'The CI log says the lockfile is stale.'],
            ['agent', 'The lockfile is stale; I regenerated it.'],
        ]);
        expect(messages[1]).toMatchObject({ from: 'lark', at: 2 });
    });

    it('thoughts in a row are ONE message; a reply between them splits them', () => {
        const messages = chatMessages(detail([
            think('t1', 'First, read the log.', 1),
            think('t2', 'Then the lockfile.', 2),
            say('r', 'agent', 'Done.', 3),
            think('t3', 'Check the next job.', 4),
        ] as never));
        expect(messages.map((m) => [m.who, m.text])).toEqual([
            ['thinking', 'First, read the log.\n\nThen the lockfile.'],
            ['agent', 'Done.'],
            ['thinking', 'Check the next job.'],
        ]);
        expect(messages[0]!.id).toBe('t1');
    });

    it('a thought with no words is not an empty message', () => {
        const messages = chatMessages(detail([think('t1', '   ', 1), say('r', 'agent', 'Done.', 2)] as never));
        expect(messages.map((m) => m.who)).toEqual(['agent']);
    });
});

describe('the chat shows it collapsed', () => {
    const base: ChatThread = { agentId: 'a1', name: 'lark', fidelity: 'declared', unread: null, context: { text: 'Working', tone: 'ok' }, messages: [] };
    const html = renderToStaticMarkup(<ChatFlyout thread={{ ...base, messages: [{ id: 't1', who: 'thinking', from: 'lark', text: 'The CI log says the **lockfile** is stale.', delivered: true, at: null }] }} onSend={() => {}} onClose={() => {}} />);

    it('a disclosure, closed by default, that says it is the agent’s thinking; the words inside it, rendered', () => {
        expect(html).toMatch(/<details[^>]*data-who="thinking"/);
        expect(html).not.toMatch(/<details[^>]*data-who="thinking"[^>]*\sopen/);
        expect(html).toMatch(/<summary[^>]*>[\s\S]*?lark’s thinking/);
        expect(html).toMatch(/<details[^>]*data-who="thinking"[\s\S]*?<strong>lockfile<\/strong>/);
    });

    it('CONTROL: a reply is not inside a disclosure', () => {
        const reply = renderToStaticMarkup(<ChatFlyout thread={{ ...base, messages: [{ id: 'r', who: 'agent', from: 'lark', text: 'Done.', delivered: true, at: null }] }} onSend={() => {}} onClose={() => {}} />);
        expect(reply).not.toContain('<details');
    });
});
