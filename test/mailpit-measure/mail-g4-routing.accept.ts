import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { connect, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { messagesForWorkspace, routeMessage, type MailSource, type MailSummary } from '../../src/core/mail-routing.js';
import { containerPlan } from '../../src/core/services.js';
import { bcryptHash } from '../../src/main/mail-bcrypt.js';
import { MailHost } from '../../src/main/mail-host.js';
import { MAILPIT_MEASURED_IMAGE } from './mailpit-image.js';

/**
 * GENIE MAIL G4 ON REAL MAILPIT MESSAGES (Tynn story #490): the routing rule run over the summaries the real image
 * stores, with G2's closed send API and G3's inbox book wired as Genie's plan wires them.
 *   - a message sent by inbox A to inbox B, carrying WRONG tags (X-Tags naming A's workspace and inbox), lands in B's
 *     Received and A's Sent, and nowhere by its tags;
 *   - a recipient only on the envelope (RCPT TO, not in any header): what Mailpit records, and that it still routes;
 *   - a message from Genie's send-API credential is Received by its addressee and Sent by nobody;
 *   - each workspace's query returns its own messages and never the other's.
 */
const run = promisify(execFile);
const docker = async (...args: string[]) => (await run('docker', args, { maxBuffer: 16 * 1024 * 1024 })).stdout.trim();
const finding = (name: string, value: unknown) => { console.log(`MAILPIT_FINDING ${name} ${JSON.stringify(value)}`); };
const SHARED: MailSource = { id: 'shared', sendApiClosed: true };
const SEND_API = { user: 'genie', password: 'G4SendApi-0001' };

let dir = '';
let name = '';
let smtpPort = 0;
let httpPort = 0;
let host: MailHost;
const api = (path: string, init?: RequestInit) => fetch(`http://127.0.0.1:${httpPort}${path}`, init);

async function ready(): Promise<void> {
    const port = async (p: string) => Number(/:(\d+)\s*$/m.exec(await docker('port', name, p))![1]);
    smtpPort = await port('1025/tcp');
    httpPort = await port('8025/tcp');
    for (let i = 0; i < 120; i++) {
        try { if ((await api('/readyz')).ok) return; } catch { /* not listening yet */ }
        await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error(`Mailpit did not become ready: ${await docker('logs', name).catch(() => '')}`);
}

/** Authenticate as `user` and send one message: the envelope recipients, and the headers given. */
async function sendAs(user: string, password: string, rcpt: readonly string[], headers: readonly string[], body = 'hello'): Promise<string> {
    const socket = await new Promise<Socket>((ok, fail) => { const s = connect(smtpPort, '127.0.0.1', () => ok(s)); s.once('error', fail); });
    socket.setEncoding('utf8');
    let buffer = '';
    socket.on('data', (d: string) => { buffer += d; });
    const reply = async () => {
        for (let i = 0; i < 100; i++) {
            const m = /^(?:\d{3}-[^\r\n]*\r\n)*\d{3}(?: [^\r\n]*)?\r\n/.exec(buffer);
            if (m) { buffer = buffer.slice(m[0].length); return m[0].trimEnd().split('\r\n').at(-1)!; }
            await new Promise((r) => setTimeout(r, 50));
        }
        throw new Error('no SMTP reply');
    };
    const send = async (line: string) => { socket.write(`${line}\r\n`); return reply(); };
    try {
        await reply();
        await send('EHLO genie-g4.test');
        const auth = await send(`AUTH PLAIN ${Buffer.from(`\0${user}\0${password}`).toString('base64')}`);
        if (!auth.startsWith('235')) throw new Error(`auth refused: ${auth}`);
        await send(`MAIL FROM:<${user}>`);
        for (const r of rcpt) await send(`RCPT TO:<${r}>`);
        await send('DATA');
        return await send(`${[...headers, 'MIME-Version: 1.0', 'Content-Type: text/plain; charset=utf-8', '', body].join('\r\n')}\r\n.`);
    } finally {
        socket.end();
    }
}

async function bySubject(subject: string): Promise<MailSummary & { Subject: string }> {
    for (let i = 0; i < 40; i++) {
        const r = await (await api('/api/v1/messages')).json() as { messages: Array<MailSummary & { Subject: string }> };
        const m = r.messages.find((x) => x.Subject === subject);
        if (m) return m;
        await new Promise((res) => setTimeout(res, 100));
    }
    throw new Error(`no message "${subject}"`);
}

beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'genie-mail-g4-'));
    name = `genie-mail-g4-${process.pid}`;
    host = await MailHost.open({
        storeFile: join(dir, 'mail-inboxes.json'),
        authDir: join(dir, 'mailpit-auth'),
        hash: bcryptHash,
        now: Date.now,
        restartMailpit: async () => { await docker('restart', name); await ready(); },
    });
    const plan = containerPlan({ engine: 'mailpit', major: '1.30', scope: { kind: 'shared' }, publishedPort: 1, surfacePorts: { ui: 2 }, credentials: SEND_API, smtpAuthDir: join(dir, 'mailpit-auth') });
    await docker('pull', MAILPIT_MEASURED_IMAGE);
    await docker('run', '-d', '--name', name, '-p', '127.0.0.1::1025', '-p', '127.0.0.1::8025', '--tmpfs', '/data',
        ...(plan.mounts ?? []).flatMap((m) => ['-v', `${m.source}:${m.target}:ro`]),
        ...Object.entries(plan.env).flatMap(([k, v]) => ['-e', `${k}=${v}`]),
        MAILPIT_MEASURED_IMAGE);
    await ready();
}, 180_000);

afterAll(async () => {
    if (name) await docker('rm', '-f', name).catch(() => '');
    if (dir) rmSync(dir, { recursive: true, force: true });
});

describe('routing real Mailpit messages', () => {
    it('A sends to B with wrong tags: B\'s Received, A\'s Sent; the tags route nothing; each workspace sees only its own', async () => {
        const a = await host.create({ workspaceId: 'ws-a', workspaceSlug: 'example-a', name: 'signup' });
        const b = await host.create({ workspaceId: 'ws-b', workspaceSlug: 'example-b', name: 'signup' });
        await sendAs(a.inbox.smtpUser, a.password, [b.inbox.address], [`From: <${a.inbox.address}>`, `To: <${b.inbox.address}>`, 'Subject: G4 wrong tags', 'X-Tags: ws-a, signup@example-a.mail.gen, example-a']);
        const m = await bySubject('G4 wrong tags');
        const route = routeMessage(m, host.list(), SHARED);
        finding('g4-wrong-tags', { Username: m.Username, Tags: m.Tags, To: m.To, route });
        // Positive control: the wrong tags really are on the message.
        expect(m.Tags).toEqual(expect.arrayContaining(['ws-a', 'signup@example-a.mail.gen']));
        expect(route).toEqual({ received: [b.inbox.id], sent: [a.inbox.id] });
    });

    it('a recipient only on the envelope (RCPT TO, in no header): what Mailpit records, and where it routes', async () => {
        const [a, b] = [host.list('ws-a')[0]!, host.list('ws-b')[0]!];
        const rotated = await host.rotate(a.id);
        await sendAs(a.smtpUser, rotated.password, [b.address], [`From: <${a.address}>`, 'To: <customer@example.test>', 'Subject: G4 envelope only']);
        const m = await bySubject('G4 envelope only');
        const route = routeMessage(m, host.list(), SHARED);
        finding('g4-envelope-only', { To: m.To, Cc: m.Cc, Bcc: m.Bcc, route });
        expect(m.Bcc.map((x) => x.Address)).toContain(b.address);
        expect(route).toEqual({ received: [b.id], sent: [a.id] });
    });

    it('Genie\'s send-API message is Received by its addressee and Sent by nobody; the workspaces\' queries hold', async () => {
        const a = host.list('ws-a')[0]!;
        const res = await api('/api/v1/send', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Basic ${Buffer.from(`${SEND_API.user}:${SEND_API.password}`).toString('base64')}` },
            body: JSON.stringify({ From: { Email: 'genie@mail.gen' }, To: [{ Email: a.address }], Subject: 'G4 send api', Text: 'x', Tags: ['ws-b'] }),
        });
        expect(res.status).toBe(200);
        const m = await bySubject('G4 send api');
        expect(routeMessage(m, host.list(), SHARED)).toEqual({ received: [a.id], sent: [] });
        const all = (await (await api('/api/v1/messages')).json() as { messages: Array<MailSummary & { Subject: string }> }).messages;
        const forA = messagesForWorkspace('ws-a', all, host.list(), SHARED).map((x) => (x as { Subject: string }).Subject).sort();
        const forB = messagesForWorkspace('ws-b', all, host.list(), SHARED).map((x) => (x as { Subject: string }).Subject).sort();
        finding('g4-workspaces', { forA, forB });
        // A sent both of its messages and was sent Genie's; B received A's two. Neither sees anything else.
        expect(forA).toEqual(['G4 envelope only', 'G4 send api', 'G4 wrong tags']);
        expect(forB).toEqual(['G4 envelope only', 'G4 wrong tags']);
    });
});
