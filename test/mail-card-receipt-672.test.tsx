import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chatCommsOf, chatThreadFrom, observedMail, type MailLike } from '../src/core/chat-view.js';
import type { AgentRow } from '../src/core/dashboard-view.js';
import { mintAgentId } from '../src/core/identity.js';
import { InboxStore } from '../src/main/inbox-store.js';
import type { AgentDetail } from '../src/renderer/bridge.js';
import { ChatFlyout } from '../src/renderer/components/ChatFlyout.js';

const T = 1_700_000_000_000;
const sender = mintAgentId(), recipient = mintAgentId();
const row = (id: string, name: string): AgentRow => ({ id, name, provider: 'claude', workspaceId: 'workspace', fidelity: 'declared', state: 'idle', duration: null, ask: null, reason: null, fixes: [], step: null, target: null, activity: null, delivery: null, collaborators: null, commsAgeSeconds: null, contextUsed: null, contextSize: null });
const agents = [row(sender, 'wren'), row(recipient, 'atlas')];
let dir: string;
let inbox: InboxStore;
beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'genie-mail-card-672-'));
    inbox = await InboxStore.open(dir, () => new Date(T).toISOString());
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

function view(rows: AgentDetail['rows'] = [], subject = recipient, lines?: number) {
    const detail: AgentDetail = { agent: { id: subject, name: subject === recipient ? 'atlas' : 'wren', provider: 'claude', fidelity: 'declared', cwd: '/workspace' }, session: null, turns: 0, cost: null, refusal: null, rows, comms: chatCommsOf(inbox.involving(subject)) };
    const thread = chatThreadFrom(detail, subject, agents, () => T, lines);
    return { thread, html: renderToStaticMarkup(<ChatFlyout thread={thread} onSend={() => {}} onOpenMail={() => {}} />) };
}
const cards = (html: string) => [...html.matchAll(/data-who="mail"/g)];

describe('Tynn672/6318: the recipient card is its notification, with two receipt states', () => {
    it('arrival, before any provider or ledger event, renders one waiting card with sender, timestamp, preview and inbox link', async () => {
        const mail = await inbox.send({ from: sender, to: recipient, text: 'Review the patch\nthen check the migration.' });
        const { html } = view();
        expect(cards(html)).toHaveLength(1);
        expect(html).toContain(`data-chat-message="${mail.id}"`);
        expect(html).toContain('wren → atlas');
        expect(html).toContain(`data-chat-time="${T}"`);
        expect(html).toContain('Review the patch then check the migration.');
        expect(html).toContain(`data-open-mail="${mail.id}"`);
        expect(html).toContain('data-mail-receipt="waiting"');
        expect(html).toContain('Waiting');
        // Both participants see the same mail record, rather than another generated message.
        expect(cards(view([], sender).html)).toHaveLength(1);
    });

    it.each(['provider accepted', 'agent pulled'] as const)('%s moves the same card from waiting to delivered using existing readAt', async (via) => {
        const mail = await inbox.send({ from: sender, to: recipient, text: 'The full mail is ready.' });
        expect(view().html).toContain('data-mail-receipt="waiting"');
        if (via === 'provider accepted') await inbox.markDelivered(recipient, [mail.id]);
        else await inbox.receive({ participant: recipient });
        const { html, thread } = view();
        expect(cards(html)).toHaveLength(1);
        expect(thread.messages[0]!.id).toBe(mail.id);
        expect(html).toContain('data-mail-receipt="delivered"');
        expect(html).toContain('Delivered');
        expect(html).not.toContain('data-mail-receipt="read"');
        expect(inbox.all()[0]!.readAt).not.toBeNull();
    });

    it('waiting includes the recorded refusal as text, and delivery removes the stale reason', async () => {
        const mail = await inbox.send({ from: sender, to: recipient, text: 'Still waiting.' });
        await inbox.recordDeliveryRefusal(recipient, [mail.id], { attempts: 5, reason: 'Provider <busy> & not ready' });
        const waiting = view().html;
        expect(waiting).toContain('data-mail-receipt="waiting"');
        expect(waiting).toContain('Provider &lt;busy&gt; &amp; not ready');
        expect(waiting).not.toContain('<busy>');
        await inbox.markDelivered(recipient, [mail.id]);
        expect(view().html).toContain('data-mail-receipt="delivered"');
        expect(view().html).not.toContain('not ready');
    });

    it('a provider notice adds neither a nudge row nor a second copy of the arriving card', async () => {
        const mail = await inbox.send({ from: sender, to: recipient, text: 'One mail, one card.' });
        const { html, thread } = view([{ id: 'provider-notice', at: T + 1, event: { kind: 'message', speaker: 'peer', peerName: 'genie', text: 'AgentInbox delivery: 1 message', mail: [{ id: mail.id, from: sender, fromName: 'wren', text: mail.text, sentAt: mail.sentAt }] } }]);
        expect(cards(html)).toHaveLength(1);
        expect(thread.messages.map((m) => m.id)).toEqual([mail.id]);
        expect(html).not.toContain('data-who="delivery"');
        expect(html).not.toContain('told atlas about');
        expect(html).not.toContain('AgentInbox delivery:');
    });

    it('legacy count nudges are hidden, while an ordinary peer message remains visible', () => {
        const { html } = view([
            { id: 'old-nudge', at: T, event: { kind: 'message', speaker: 'peer', peerName: 'genie', text: 'You have 1 unread AgentInbox message; collect it with agentinbox receive.' } },
            { id: 'real-peer', at: T + 1, event: { kind: 'message', speaker: 'peer', peerName: 'wren', text: 'Please review the AgentInbox change.' } },
        ]);
        expect(html).not.toContain('collect it with agentinbox receive');
        expect(html).toContain('Please review the AgentInbox change.');
    });

    it('the live ledger window does not let a nudge hide an arriving card at a new turn boundary', async () => {
        const mail = await inbox.send({ from: sender, to: recipient, text: 'Arriving at a quiet turn.' });
        const { thread, html } = view([
            { id: 'old-reply', at: T - 10, event: { kind: 'message', speaker: 'agent', peerName: null, text: 'Earlier work.' } },
            { id: 'new-turn', at: T + 1, event: { kind: 'turn', n: 2, by: null } },
            { id: 'provider-notice', at: T + 2, event: { kind: 'message', speaker: 'peer', peerName: 'genie', text: 'AgentInbox delivery: 1 message', mail: [{ id: mail.id, from: sender, fromName: 'wren', text: mail.text, sentAt: mail.sentAt }] } },
        ], recipient, 1);
        expect(thread.messages.filter(m => m.mailId === mail.id)).toHaveLength(1);
        expect(cards(html)).toHaveLength(1);
        expect(html).not.toContain('told atlas');
    });

    it('an observed recipient also sees a peer card at arrival, then delivered after its inbox receive', async () => {
        const mail = await inbox.send({ from: sender, to: recipient, text: 'Mail for the Take Over agent.' });
        const readObserved = observedMail as (recent: readonly MailLike[] | null, id: string, name: string, peers?: readonly AgentRow[]) => ReturnType<typeof observedMail>;
        const render = () => renderToStaticMarkup(<ChatFlyout thread={{ agentId: recipient, name: 'atlas', fidelity: 'observed', ...readObserved(chatCommsOf(inbox.involving(recipient)), recipient, 'atlas', agents) }} onSend={() => {}} />);
        expect(render()).toContain('data-mail-receipt="waiting"');
        expect(render()).toContain('wren → atlas');
        await inbox.receive({ participant: recipient });
        const html = render();
        expect(cards(html)).toHaveLength(1);
        expect(html).toContain(`data-chat-message="${mail.id}"`);
        expect(html).toContain('data-mail-receipt="delivered"');
        expect(html).not.toContain('data-chat-read=');
    });
});
