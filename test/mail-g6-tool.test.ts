import { describe, expect, it } from 'vitest';
import type { JsonObject } from '@particle-academy/prism-mcp';
import type { Inbox } from '../src/core/mail.js';
import { HOST_NATIVE_TOOLS, hostRegistrations } from '../src/main/mcp-host-tools.js';
import { mailTools, type MailPort } from '../src/main/mcp-tools-mail.js';
import type { MailpitMessage, MailpitReader, MailpitSummary } from '../src/main/mailpit-reader.js';
import type { Caller } from '../src/main/mcp-tools.js';

/**
 * GENIE MAIL G6: THE `mail` MCP TOOL (Tynn story #492; spec .ai/plans/specs/genie-mail.md). An agent creates its
 * workspace's inboxes, lists them, reads their messages and deletes or rotates them, through Genie's host. Every call is
 * the CALLER's workspace's: another workspace's inbox or message is refused by name, and nothing is read, deleted or
 * marked read on the way (the refusal is decided on the message's summary, before Mailpit is asked for the message).
 * The real Mailpit end to end: test/mailpit-measure/mail-g6-tool.accept.ts.
 */
const callers: Record<string, Caller> = {
    'term-a': { agentId: 'agent-a', workspaceId: 'ws-a', workspacePath: '/w/a' } as Caller,
    'term-b': { agentId: 'agent-b', workspaceId: 'ws-b', workspacePath: '/w/b' } as Caller,
};

const inbox = (id: string, workspaceId: string, name: string, slug: string): Inbox => ({ id, workspaceId, name, address: `${name}@${slug}.mail.gen`, smtpUser: `${name}@${slug}.mail.gen`, createdAt: 0 });
const who = (address: string) => ({ Address: address, Name: '' });

function summary(id: string, over: Partial<MailpitSummary>): MailpitSummary {
    return {
        ID: id, MessageID: `${id}@x`, Read: false, From: who('app@ws-a.mail.gen'), To: [], Cc: [], Bcc: [], ReplyTo: [], Subject: `subject ${id}`,
        Created: '2026-11-08T10:00:00Z', Size: 100, Attachments: 0, Snippet: `snippet ${id}`, Tags: [], ...over,
    };
}

function fixture() {
    const inboxes: Inbox[] = [inbox('in-a-app', 'ws-a', 'app', 'ws-a'), inbox('in-a-signup', 'ws-a', 'signup', 'ws-a'), inbox('in-b-app', 'ws-b', 'app', 'ws-b')];
    // Newest first, as Mailpit lists them.
    const summaries: MailpitSummary[] = [
        summary('m4', { To: [who('signup@ws-a.mail.gen')], Read: true, Created: '2026-11-08T10:04:00Z' }),
        summary('m3', { From: who('app@ws-b.mail.gen'), To: [who('someone@example.test')], Username: 'app@ws-b.mail.gen', Created: '2026-11-08T10:03:00Z' }),
        summary('m2', { To: [who('app@ws-a.mail.gen')], Subject: 'Welcome aboard', Attachments: 1, Created: '2026-11-08T10:02:00Z' }),
        summary('m1', { To: [who('stranger@example.test')], Tags: ['ws-a'], Created: '2026-11-08T10:01:00Z' }),
    ];
    const asked: string[] = [];
    const removed: string[][] = [];
    const reader: MailpitReader = {
        source: { id: 'shared', sendApiClosed: true },
        page: async ({ start, limit, search }) => {
            asked.push(`page:${start}:${limit}${search ? `:${search}` : ''}`);
            const pool = search ? summaries.filter((s) => s.Subject.toLowerCase().includes(search.toLowerCase())) : summaries;
            return { messages: pool.slice(start, start + limit), total: pool.length };
        },
        message: async (id) => {
            asked.push(`message:${id}`);
            const s = summaries.find((m) => m.ID === id)!;
            const full: MailpitMessage = {
                ID: s.ID, MessageID: s.MessageID, From: s.From, To: s.To, Cc: s.Cc, Bcc: s.Bcc, ReplyTo: s.ReplyTo, ReturnPath: 'bounce@ws-a.mail.gen',
                Subject: s.Subject, Date: s.Created, Tags: s.Tags, Size: s.Size, Text: `text of ${id}`, HTML: `<p>html of ${id}</p>`, Inline: [],
                Attachments: [{ PartID: '2', FileName: 'invoice.pdf', ContentType: 'application/pdf', ContentID: '', Size: 2048 }],
            };
            return full;
        },
        headers: async (id) => { asked.push(`headers:${id}`); return { Subject: [`subject ${id}`], 'Message-Id': [`<${id}@x>`] }; },
        remove: async (ids) => { asked.push(`remove:${ids.join(',')}`); removed.push([...ids]); },
    };
    const port: MailPort = {
        inboxes: (ws) => inboxes.filter((i) => i.workspaceId === ws),
        create: async (ws, name) => { const made = inbox(`in-${ws}-${name}`, ws, name, ws); inboxes.push(made); return { inbox: made, password: 'Once-Only-Password-1' }; },
        rotate: async (ws, id) => ({ inbox: inboxes.find((i) => i.id === id && i.workspaceId === ws)!, password: 'Rotated-Password-2' }),
        remove: async (ws, id) => { const at = inboxes.findIndex((i) => i.id === id && i.workspaceId === ws); inboxes.splice(at, 1); },
        smtp: () => ({ host: 'mail.gen', port: 4101 }),
        reader: () => reader,
    };
    const [tool] = mailTools({ resolveCaller: (id) => callers[id] ?? null, mail: port });
    const call = async (terminalId: string, args: JsonObject) => {
        const r = await tool!.handler({ ...args, terminalId }, { server: 'genie', tool: 'mail', headers: {} });
        return { isError: r.isError === true, body: JSON.parse(r.text) as Record<string, any>, text: r.text };
    };
    return { call, asked, removed, inboxes, tool: tool! };
}

describe('another workspace\'s mail is refused by name, and nothing is read on the way', () => {
    it('workspace B\'s agent calling read on A\'s message is refused, naming the message; Mailpit is never asked for it', async () => {
        const f = fixture();
        const r = await f.call('term-b', { action: 'read', id: 'm2' });
        expect(r.isError).toBe(true);
        expect(r.body.error).toMatch(/m2 is not in this workspace.s inboxes/);
        expect(r.text).not.toContain('Welcome aboard');
        expect(f.asked.filter((a) => a.startsWith('message:') || a.startsWith('headers:'))).toEqual([]);
    });

    it('CONTROL: A\'s own agent reads the same message: text, HTML, headers and attachment metadata', async () => {
        const f = fixture();
        const r = await f.call('term-a', { action: 'read', id: 'm2' });
        expect(r.isError).toBe(false);
        expect(r.body.message).toMatchObject({
            id: 'm2', subject: 'Welcome aboard', from: 'app@ws-a.mail.gen', to: ['app@ws-a.mail.gen'], inboxes: ['app'],
            text: 'text of m2', html: '<p>html of m2</p>', headers: { Subject: ['subject m2'] },
            attachments: [{ partId: '2', fileName: 'invoice.pdf', contentType: 'application/pdf', size: 2048 }],
        });
    });

    it('a message carrying A\'s TAG but addressed to nobody of A\'s is not A\'s (tags never route)', async () => {
        const f = fixture();
        const r = await f.call('term-a', { action: 'read', id: 'm1' });
        expect(r.isError).toBe(true);
        expect(r.body.error).toMatch(/m1 is not in this workspace.s inboxes/);
    });

    it('a message B SENT (its inbox\'s SMTP user) is B\'s to read, and not A\'s', async () => {
        const f = fixture();
        expect((await f.call('term-b', { action: 'read', id: 'm3' })).body.message).toMatchObject({ id: 'm3', inboxes: ['app'] });
        expect((await f.call('term-a', { action: 'read', id: 'm3' })).body.error).toMatch(/m3 is not in this workspace.s inboxes/);
    });

    it('an id that is no message at all gets the same words: no telling whose it is', async () => {
        const f = fixture();
        expect((await f.call('term-b', { action: 'read', id: 'nope' })).body.error).toMatch(/nope is not in this workspace.s inboxes/);
    });

    it('B deleting A\'s message is refused by name and nothing is deleted; A\'s own delete goes through', async () => {
        const f = fixture();
        const refused = await f.call('term-b', { action: 'delete', id: 'm2' });
        expect(refused.isError).toBe(true);
        expect(refused.body.error).toMatch(/m2 is not in this workspace.s inboxes/);
        expect(f.removed).toEqual([]);
        const done = await f.call('term-a', { action: 'delete', id: 'm2' });
        expect(done.body).toMatchObject({ ok: true, deleted: 'm2' });
        expect(f.removed).toEqual([['m2']]);
    });

    it('B rotating or deleting A\'s inbox is refused by name, with nothing changed', async () => {
        const f = fixture();
        expect((await f.call('term-b', { action: 'rotate', inbox: 'signup' })).body.error).toMatch(/signup is not one of this workspace.s inboxes/);
        expect((await f.call('term-b', { action: 'delete', inbox: 'in-a-signup' })).body.error).toMatch(/in-a-signup is not one of this workspace.s inboxes/);
        expect(f.inboxes.map((i) => i.id)).toContain('in-a-signup');
    });
});

describe('create, list, messages, read, delete and rotate for the caller\'s own inboxes', () => {
    it('create answers the address, SMTP host, port, user and password (shown once)', async () => {
        const f = fixture();
        const r = await f.call('term-b', { action: 'create', name: 'signup' });
        expect(r.isError).toBe(false);
        expect(r.body).toMatchObject({
            ok: true,
            inbox: { id: 'in-ws-b-signup', name: 'signup', address: 'signup@ws-b.mail.gen' },
            smtp: { host: 'mail.gen', port: 4101, user: 'signup@ws-b.mail.gen', password: 'Once-Only-Password-1' },
        });
        expect(r.body.note).toMatch(/once/i);
    });

    it('create needs a name', async () => {
        const f = fixture();
        expect((await f.call('term-b', { action: 'create' })).body.error).toMatch(/create needs `name`/);
    });

    it('list: this workspace\'s inboxes only, never a password', async () => {
        const f = fixture();
        const r = await f.call('term-a', { action: 'list' });
        expect(r.body.inboxes.map((i: { name: string }) => i.name)).toEqual(['app', 'signup']);
        expect(r.text).not.toMatch(/password/i);
    });

    it('messages: newest first, metadata only, this workspace\'s only', async () => {
        const f = fixture();
        const r = await f.call('term-a', { action: 'messages' });
        expect(r.body.messages.map((m: { id: string }) => m.id)).toEqual(['m4', 'm2']);
        expect(r.body.messages[1]).toMatchObject({ id: 'm2', subject: 'Welcome aboard', from: 'app@ws-a.mail.gen', to: ['app@ws-a.mail.gen'], inboxes: ['app'], read: false, attachments: 1, snippet: 'snippet m2' });
        for (const m of r.body.messages) { expect(m).not.toHaveProperty('text'); expect(m).not.toHaveProperty('html'); }
    });

    it('messages {inbox}: that inbox only; {unread}: unread only; {search}: Mailpit\'s search; {limit}', async () => {
        const f = fixture();
        expect((await f.call('term-a', { action: 'messages', inbox: 'signup' })).body.messages.map((m: { id: string }) => m.id)).toEqual(['m4']);
        expect((await f.call('term-a', { action: 'messages', unread: true })).body.messages.map((m: { id: string }) => m.id)).toEqual(['m2']);
        expect((await f.call('term-a', { action: 'messages', search: 'welcome' })).body.messages.map((m: { id: string }) => m.id)).toEqual(['m2']);
        expect(f.asked).toContain('page:0:200:welcome');
        expect((await f.call('term-a', { action: 'messages', limit: 1 })).body.messages.map((m: { id: string }) => m.id)).toEqual(['m4']);
        expect((await f.call('term-a', { action: 'messages', inbox: 'in-b-app' })).body.error).toMatch(/in-b-app is not one of this workspace.s inboxes/);
    });

    it('rotate answers the new password once; delete {inbox} removes it', async () => {
        const f = fixture();
        const r = await f.call('term-a', { action: 'rotate', inbox: 'signup' });
        expect(r.body).toMatchObject({ ok: true, inbox: { name: 'signup' }, smtp: { host: 'mail.gen', port: 4101, user: 'signup@ws-a.mail.gen', password: 'Rotated-Password-2' } });
        const d = await f.call('term-a', { action: 'delete', inbox: 'signup' });
        expect(d.body).toMatchObject({ ok: true, deletedInbox: 'signup@ws-a.mail.gen' });
        expect(f.inboxes.map((i) => i.id)).not.toContain('in-a-signup');
    });

    it('the default inbox is not deleted: its sites and processes send as it', async () => {
        const f = fixture();
        const r = await f.call('term-a', { action: 'delete', inbox: 'app' });
        expect(r.isError).toBe(true);
        expect(r.body.error).toMatch(/default inbox/);
        expect(f.inboxes.map((i) => i.id)).toContain('in-a-app');
    });

    it('delete takes a message `id` or an `inbox`, not both', async () => {
        const f = fixture();
        expect((await f.call('term-a', { action: 'delete', id: 'm2', inbox: 'signup' })).body.error).toMatch(/either/);
    });

    it('with no Genie Mail here (doctor mode) every action says so', async () => {
        const [tool] = mailTools({ resolveCaller: (id) => callers[id] ?? null, mail: null });
        const r = await tool!.handler({ action: 'list', terminalId: 'term-a' }, { server: 'genie', tool: 'mail', headers: {} });
        expect(r.isError).toBe(true);
        expect(r.text).toMatch(/no Genie Mail/);
    });

    it('a workspace with no shared Mailpit is told how to get one, and nothing is created', async () => {
        const f = fixture();
        const [tool] = mailTools({ resolveCaller: (id) => callers[id] ?? null, mail: { ...({} as MailPort), inboxes: () => [], smtp: () => null, reader: () => null, create: async () => { throw new Error('must not be called'); }, rotate: async () => { throw new Error('x'); }, remove: async () => { throw new Error('x'); } } });
        const r = await tool!.handler({ action: 'create', name: 'signup', terminalId: 'term-a' }, { server: 'genie', tool: 'mail', headers: {} });
        expect(r.isError).toBe(true);
        expect(r.text).toMatch(/services add/);
        expect(f.inboxes).toHaveLength(3);
    });
});

describe('the tool is the host\'s: it works with no window open', () => {
    it('mail is host-native', () => {
        expect(HOST_NATIVE_TOOLS.has('mail')).toBe(true);
    });

    it('with the window closed, a mail call is answered by the host, not refused as a window tool', async () => {
        const f = fixture();
        const [served] = hostRegistrations([f.tool], {
            resolveCaller: (id) => callers[id] ?? null,
            window: { connected: () => false, call: async () => { throw new Error('no window'); } },
            openFileLater: () => {},
        });
        const r = await served!.handler({ action: 'list', terminalId: 'term-a' }, { server: 'genie', tool: 'mail', headers: {} });
        expect(r.isError).toBe(false);
        expect(JSON.parse(r.text).inboxes).toHaveLength(2);
    });
});
