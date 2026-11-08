import { describe, expect, it } from 'vitest';
import type { Inbox } from '../src/core/mail.js';
import { messagesForWorkspace, routeMessage, type MailSource, type MailSummary } from '../src/core/mail-routing.js';

/**
 * GENIE MAIL G4 (Tynn story #490, spec .ai/plans/specs/genie-mail.md): WHICH INBOX A MESSAGE BELONGS TO, decided by the
 * host from facts it can trust, never by a tag and never by a username it cannot vouch for (G1's finding 6, genie#1712).
 *
 *   - RECEIVED: a message belongs to an inbox it was addressed to (To, Cc or Bcc), matched against the book.
 *   - SENT: a message belongs to the inbox whose SMTP user sent it, only on a source where a message's Username can come
 *     from nothing but authenticated SMTP: Genie's shared Mailpit, whose send API is closed with Genie's own credential
 *     (G2). On any other source (a kept per-workspace Mailpit, one taken over from Genie 1) the send API is open and
 *     anyone can claim a Username, so it counts for nothing.
 *   - TAGS never route. A message tagged with another workspace's name or inbox lands where its addresses say.
 * A workspace's query returns only messages routed to its own inboxes.
 */
const inbox = (id: string, workspaceId: string, name: string, slug: string): Inbox => ({ id, workspaceId, name, address: `${name}@${slug}.mail.gen`, smtpUser: `${name}@${slug}.mail.gen`, createdAt: 0 });
const A1 = inbox('a1', 'ws-a', 'signup', 'example-a');
const A2 = inbox('a2', 'ws-a', 'qa', 'example-a');
const B1 = inbox('b1', 'ws-b', 'signup', 'example-b');
const BOOK = [A1, A2, B1];
const SHARED: MailSource = { id: 'shared', sendApiClosed: true };
const KEPT: MailSource = { id: 'kept-a', sendApiClosed: false };
const addr = (Address: string, Name = '') => ({ Name, Address });
const msg = (over: Partial<MailSummary> = {}): MailSummary => ({ ID: 'm', From: addr('app@example.test'), To: [], Cc: [], Bcc: [], Username: '', Tags: [], ...over });

describe('routing a message to inboxes', () => {
    it('a message tagged wrong but addressed to inbox X lands only in X', () => {
        const m = msg({ To: [addr('signup@example-a.mail.gen')], Tags: ['example-b', 'signup@example-b.mail.gen', 'b1', 'ws-b'] });
        expect(routeMessage(m, BOOK, SHARED)).toEqual({ received: ['a1'], sent: [] });
    });

    it('received by To, Cc or Bcc, case-insensitively and with a display name; several inboxes when it was sent to several', () => {
        const m = msg({ To: [addr('SignUp@Example-A.Mail.Gen', 'Sign Up')], Cc: [addr('qa@example-a.mail.gen')], Bcc: [addr('signup@example-b.mail.gen')] });
        expect(routeMessage(m, BOOK, SHARED)).toEqual({ received: ['a1', 'a2', 'b1'], sent: [] });
        // Control: an address that is no inbox routes nowhere.
        expect(routeMessage(msg({ To: [addr('nobody@example-a.mail.gen')] }), BOOK, SHARED)).toEqual({ received: [], sent: [] });
    });

    it('sent by the inbox whose SMTP user sent it, on Genie\'s shared Mailpit (send API closed)', () => {
        const m = msg({ Username: 'signup@example-a.mail.gen', To: [addr('customer@example.test')] });
        expect(routeMessage(m, BOOK, SHARED)).toEqual({ received: [], sent: ['a1'] });
    });

    it('a Username counts for nothing where the send API is open (finding 6): no Sent, only what the addresses say', () => {
        const forged = msg({ Username: 'signup@example-b.mail.gen', Tags: ['signup@example-b.mail.gen'], To: [addr('qa@example-a.mail.gen')] });
        expect(routeMessage(forged, BOOK, KEPT)).toEqual({ received: ['a2'], sent: [] });
        // Control: the same message on the shared Mailpit, where only authenticated SMTP sets a Username, is B's Sent.
        expect(routeMessage(forged, BOOK, SHARED)).toEqual({ received: ['a2'], sent: ['b1'] });
    });

    it('a Username that names no inbox (Genie\'s own send-API user, a stranger) routes nowhere', () => {
        expect(routeMessage(msg({ Username: 'genie' }), BOOK, SHARED)).toEqual({ received: [], sent: [] });
        expect(routeMessage(msg({ Username: 'example-a' }), BOOK, SHARED)).toEqual({ received: [], sent: [] });
    });
});

describe('a workspace\'s messages', () => {
    const own = msg({ ID: 'own', To: [addr('signup@example-a.mail.gen')] });
    const theirs = msg({ ID: 'theirs', To: [addr('signup@example-b.mail.gen')], Tags: ['example-a', 'ws-a', 'signup@example-a.mail.gen'] });
    const sentByB = msg({ ID: 'sent-by-b', Username: 'signup@example-b.mail.gen', To: [addr('x@example.test')], Tags: ['ws-a'] });
    const forgedAsA = msg({ ID: 'forged-as-a', Username: 'signup@example-a.mail.gen', Tags: ['signup@example-a.mail.gen'], To: [addr('x@example.test')] });

    it('never returns another workspace\'s message, however it is tagged (positive control: its own message is returned)', () => {
        expect(messagesForWorkspace('ws-a', [own, theirs, sentByB], BOOK, SHARED).map((m) => m.ID)).toEqual(['own']);
        expect(messagesForWorkspace('ws-b', [own, theirs, sentByB], BOOK, SHARED).map((m) => m.ID)).toEqual(['theirs', 'sent-by-b']);
    });

    it('a Username claimed on an open source gives a workspace nothing (control: the same on the shared Mailpit is A\'s Sent)', () => {
        expect(messagesForWorkspace('ws-a', [forgedAsA], BOOK, KEPT)).toEqual([]);
        expect(messagesForWorkspace('ws-a', [forgedAsA], BOOK, SHARED).map((m) => m.ID)).toEqual(['forged-as-a']);
    });

    it('a workspace with no inboxes has no messages', () => {
        expect(messagesForWorkspace('ws-c', [own, theirs, sentByB], BOOK, SHARED)).toEqual([]);
    });
});
