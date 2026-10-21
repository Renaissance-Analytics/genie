import { isValidElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { AgentRow } from '../src/core/dashboard-view.js';
import { chatCommsOf, chatThreadFrom, mailSubject, type MailLike } from '../src/core/chat-view.js';
import type { AgentDetail } from '../src/renderer/bridge.js';
import { ChatDeliveryRow, ChatFlyout, ChatMailRow } from '../src/renderer/components/ChatFlyout.js';

/**
 * AGENTINBOX MAIL IN THE CHAT, WITH ITS CONTEXT (beta.33 items 7 + 18).
 *
 * The owner (screenshot: "genie → tynn · You have 1 unread AgentInbox message; collect it with agentinbox receive"):
 * "I need to be able to see the context in agentInbox deliveries … In a chat I should be able to click an inbox post and
 * have it open the agent inbox." And: "I did not see the msg post from answering the FTQ appear."
 *
 * This file used to pin the opposite contract — "mail with the person is not one of these (it is the conversation
 * itself)" and a one-line subject per agent mail. Both were wrong for a declared agent: the person's mail to it (an FTQ
 * answer is one) is NOT in its conversation — the session never sees it until the agent calls `receive` — so the
 * person's answer never appeared anywhere in the chat; and a one-line subject is exactly the missing context. The new
 * contract, per the owner's words above:
 *  - every piece of the subject's mail — with the person, either way, and with another agent, either way — is a MAIL
 *    row at the time it was sent, naming both ends, with the whole text (an FTQ answer: question header, the option
 *    chosen, the note), and it opens that message in the AgentInbox;
 *  - Genie's notice turn ("You have 1 unread…") is a DELIVERY row that names each message it told the agent about —
 *    who from and what it says — each one opening that message;
 *  - mail between two other agents is still not this agent's.
 */
const T = 1_700_000_000_000;
const rowOf = (id: string, name: string): AgentRow => ({
    id, name, provider: 'claude', workspaceId: 'tynn', fidelity: 'declared', state: 'working', duration: null, ask: null, reason: null, fixes: [],
    step: null, target: null, activity: null, delivery: null, collaborators: null, commsAgeSeconds: null, contextUsed: null, contextSize: null,
});
const rows = [rowOf('a1', 'atlas'), rowOf('a2', 'wren'), rowOf('a3', 'vesper')];
const mail = (id: string, from: string, to: string, text: string, at: number): MailLike => ({ id, from, to, text, sentAt: new Date(at).toISOString(), readAt: null });
const FTQ_ANSWER = 'Answer to your question q_1:\n- **Deploy** — Ship it tonight?\n  → Yes\n  Note: after the backup';
const NOTICE = 'You have 1 unread AgentInbox message; collect it with agentinbox receive.';
const detail = (comms: readonly MailLike[] | null | undefined, extra: AgentDetail['rows'] = []): AgentDetail => ({
    agent: { id: 'a1', name: 'atlas', provider: 'claude', fidelity: 'declared', cwd: '/w/tynn' },
    session: null, turns: 0, cost: null, refusal: null,
    rows: [
        { id: 'e1', event: { kind: 'message', speaker: 'you', peerName: null, text: 'Use the cache driver.' }, at: T },
        { id: 'e2', event: { kind: 'message', speaker: 'agent', peerName: null, text: 'ChallengeStore is committed.' }, at: T + 120_000 },
        ...extra,
    ],
    ...(comms === undefined ? {} : { comms }),
});

describe('the thread', () => {
    it('every piece of the subject’s mail is a MAIL row in time order, naming both ends, with its whole text — the person’s too; other agents’ mail is not', () => {
        const thread = chatThreadFrom(detail([
            mail('m1', 'a1', 'a2', 'drop challenges table from migration\nthe store replaces it', T + 60_000),
            mail('m2', 'human', 'a1', FTQ_ANSWER, T + 70_000),
            mail('m3', 'a2', 'a3', 'not about atlas', T + 80_000),
            mail('m4', 'a3', 'a1', 'review done', T + 180_000),
            mail('m5', 'a1', 'human', 'Shipped; the backup ran first.', T + 190_000),
        ]), 'a1', rows, () => 0);
        expect(thread.messages.map((m) => [m.id, m.who, m.from, m.text])).toEqual([
            ['e1', 'you', 'you', 'Use the cache driver.'],
            ['m1', 'mail', 'atlas → wren', 'drop challenges table from migration\nthe store replaces it'],
            ['m2', 'mail', 'you → atlas', FTQ_ANSWER],
            ['e2', 'agent', 'atlas', 'ChallengeStore is committed.'],
            ['m4', 'mail', 'vesper → atlas', 'review done'],
            ['m5', 'mail', 'atlas → you', 'Shipped; the backup ran first.'],
        ]);
        // Each opens ITS message in the AgentInbox.
        expect(thread.messages.filter((m) => m.who === 'mail').map((m) => m.mailId)).toEqual(['m1', 'm2', 'm4', 'm5']);
    });

    it('no mail read yet (absent or null) adds nothing (positive control: the same thread with mail has rows)', () => {
        expect(chatThreadFrom(detail(undefined), 'a1', rows, () => 0).messages.map((m) => m.id)).toEqual(['e1', 'e2']);
        expect(chatThreadFrom(detail(null), 'a1', rows, () => 0).messages.map((m) => m.id)).toEqual(['e1', 'e2']);
        expect(chatThreadFrom(detail([mail('m1', 'a1', 'a2', 'x', T + 1)]), 'a1', rows, () => 0).messages.some((m) => m.who === 'mail')).toBe(true);
    });

    it('Genie’s notice turn is a DELIVERY row naming each message it told about — who from, and what it says', () => {
        const thread = chatThreadFrom(detail(null, [{
            id: 'e3',
            event: { kind: 'message', speaker: 'peer', peerName: 'genie', text: NOTICE, mail: [{ id: 'm2', from: 'human', fromName: null, text: FTQ_ANSWER, sentAt: new Date(T + 70_000).toISOString() }] },
            at: T + 130_000,
        }]), 'a1', rows, () => 0);
        const delivery = thread.messages.find((m) => m.id === 'e3')!;
        expect(delivery.who).toBe('delivery');
        expect(delivery.from).toBe('genie → atlas');
        expect(delivery.text).toBe('told atlas about 1 AgentInbox message');
        expect(delivery.mail).toEqual([{ id: 'm2', from: 'you', subject: 'Answer to your question q_1: Deploy — Ship it tonight? → Yes · Note: after the backup' }]);
    });

    it('a notice from before this change (no mail on it) still reads as Genie’s message — never an empty delivery', () => {
        const thread = chatThreadFrom(detail(null, [{ id: 'e3', event: { kind: 'message', speaker: 'peer', peerName: 'genie', text: NOTICE }, at: T + 130_000 }]), 'a1', rows, () => 0);
        expect(thread.messages.find((m) => m.id === 'e3')).toMatchObject({ who: 'peer', from: 'genie → atlas', text: NOTICE });
    });

    it('a delivery names an agent sender by name (its record’s, else the name it had when told, else its id)', () => {
        const ev = (from: string, fromName: string | null) => ({ id: 'e3', event: { kind: 'message' as const, speaker: 'peer' as const, peerName: 'genie', text: NOTICE, mail: [{ id: 'mx', from, fromName, text: 'hi', sentAt: new Date(T).toISOString() }] }, at: T + 1 });
        expect(chatThreadFrom(detail(null, [ev('a2', 'old-wren')]), 'a1', rows, () => 0).messages.find((m) => m.id === 'e3')!.mail![0]!.from).toBe('wren');
        expect(chatThreadFrom(detail(null, [ev('a9', 'gone')]), 'a1', rows, () => 0).messages.find((m) => m.id === 'e3')!.mail![0]!.from).toBe('gone');
        expect(chatThreadFrom(detail(null, [ev('a9', null)]), 'a1', rows, () => 0).messages.find((m) => m.id === 'e3')!.mail![0]!.from).toBe('a9');
    });
});

describe('what the chat is handed (main’s detail)', () => {
    it('keeps the person’s mail with the agent — an FTQ answer reaches the chat the moment it is sent', () => {
        const kept = chatCommsOf([
            { id: 'm2', from: 'human', to: 'a1', text: FTQ_ANSWER, sentAt: 'x', readAt: null, seq: 1, attachments: [] } as MailLike,
            { id: 'm1', from: 'a1', to: 'a2', text: 'hi', sentAt: 'y', readAt: 'z' } as MailLike,
        ]);
        expect(kept).toEqual([
            { id: 'm2', from: 'human', to: 'a1', text: FTQ_ANSWER, sentAt: 'x', readAt: null },
            { id: 'm1', from: 'a1', to: 'a2', text: 'hi', sentAt: 'y', readAt: 'z' },
        ]);
    });
});

describe('a subject line', () => {
    it('one line of what the message says: markdown marks and list bullets dropped, lines joined, a note kept', () => {
        expect(mailSubject(FTQ_ANSWER)).toBe('Answer to your question q_1: Deploy — Ship it tonight? → Yes · Note: after the backup');
        expect(mailSubject('review done')).toBe('review done');
        expect(mailSubject('x'.repeat(300))).toHaveLength(160);
    });
});

/** Every element in a rendered tree whose props match — the press is made on the element itself (hook-free rows). */
type Props = Record<string, unknown> & { children?: ReactNode };
function findAll(node: ReactNode, match: (p: Props) => boolean, out: Props[] = []): Props[] {
    if (Array.isArray(node)) { for (const n of node) findAll(n, match, out); return out; }
    if (!isValidElement(node)) return out;
    const props = node.props as Props;
    if (match(props)) out.push(props);
    findAll(props.children, match, out);
    return out;
}

describe('the rows', () => {
    // Changed 2026-10-21 (the owner, of a chat full of mail: "reduce the size of these. I don't need to see so much content,
    // that is what the link to open it is for"): a mail row is its head and a SHORT preview, not the whole message.
    it('a MAIL row: who to whom, a short plain preview (not the whole message), and a press opens it in the AgentInbox', () => {
        const thread = chatThreadFrom(detail([mail('m2', 'human', 'a1', FTQ_ANSWER, T + 70_000)]), 'a1', rows, () => 0);
        const html = renderToStaticMarkup(<ChatFlyout thread={thread} onSend={() => {}} onClose={() => {}} onOpenMail={() => {}} />);
        expect(html).toMatch(/data-chat-message="m2" data-who="mail"[\s\S]*you → atlas[\s\S]*Deploy — Ship it tonight\? → Yes · Note: after the backup/);
        const mailHtml = html.slice(html.indexOf('data-chat-message="m2"'));
        const preview = /data-mail-preview="[^"]*"[^>]*class="([^"]*)"/.exec(mailHtml) ?? /class="([^"]*)"[^>]*data-mail-preview=/.exec(mailHtml);
        expect(preview?.[1]).toMatch(/\bline-clamp-2\b/);
        // Not the message rendered: no list, no bold — the AgentInbox is where it is read in full.
        expect(mailHtml.slice(0, mailHtml.indexOf('</div></div>'))).not.toMatch(/<(ul|li|strong|h\d)\b/);
        // A long message is cut short, with an ellipsis.
        const long = chatThreadFrom(detail([mail('m9', 'a2', 'a1', `- **first**\n${'word '.repeat(200)}`, T + 80_000)]), 'a1', rows, () => 0);
        const longRow = renderToStaticMarkup(ChatMailRow({ m: long.messages.find((m) => m.id === 'm9')! }));
        expect(longRow).toMatch(/…/);
        expect(longRow.length).toBeLessThan(2_000);
        const opened: string[] = [];
        const row = ChatMailRow({ m: thread.messages.find((m) => m.id === 'm2')!, onOpenMail: (id) => opened.push(id) });
        const buttons = findAll(row, (p) => p['data-open-mail'] !== undefined);
        expect(buttons).toHaveLength(1);
        (buttons[0]!.onClick as () => void)();
        expect(opened).toEqual(['m2']);
    });

    it('a DELIVERY row: one entry per message told about, each naming who from and what it says, each opening its message', () => {
        const thread = chatThreadFrom(detail(null, [{
            id: 'e3',
            event: { kind: 'message', speaker: 'peer', peerName: 'genie', text: 'You have 2 unread AgentInbox messages; collect them with agentinbox receive.', mail: [
                { id: 'm2', from: 'human', fromName: null, text: FTQ_ANSWER, sentAt: new Date(T).toISOString() },
                { id: 'm4', from: 'a3', fromName: 'vesper', text: 'review done', sentAt: new Date(T).toISOString() },
            ] },
            at: T + 130_000,
        }]), 'a1', rows, () => 0);
        const m = thread.messages.find((x) => x.id === 'e3')!;
        const html = renderToStaticMarkup(<ChatFlyout thread={thread} onSend={() => {}} onClose={() => {}} onOpenMail={() => {}} />);
        expect(html).toMatch(/data-chat-message="e3" data-who="delivery"[\s\S]*told atlas about 2 AgentInbox messages[\s\S]*from you[\s\S]*Deploy — Ship it tonight\? → Yes[\s\S]*from vesper[\s\S]*review done/);
        // The notice's own words to the agent ("collect it with agentinbox receive") are an instruction to it, not context.
        expect(html).not.toContain('agentinbox receive');
        const opened: string[] = [];
        const buttons = findAll(ChatDeliveryRow({ m, onOpenMail: (id) => opened.push(id) }), (p) => p['data-open-mail'] !== undefined);
        expect(buttons).toHaveLength(2);
        for (const b of buttons) (b.onClick as () => void)();
        expect(opened).toEqual(['m2', 'm4']);
    });

    it('with nowhere to open mail (no onOpenMail) the rows still show their context, as text, not as dead buttons', () => {
        const m = chatThreadFrom(detail([mail('m2', 'human', 'a1', FTQ_ANSWER, T)]), 'a1', rows, () => 0).messages.find((x) => x.id === 'm2')!;
        expect(findAll(ChatMailRow({ m }), (p) => p['data-open-mail'] !== undefined)).toHaveLength(0);
        expect(renderToStaticMarkup(ChatMailRow({ m }))).toContain('you → atlas');
    });
});
