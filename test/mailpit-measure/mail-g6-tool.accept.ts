import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { connect, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { JsonObject } from '@particle-academy/prism-mcp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { containerPlan } from '../../src/core/services.js';
import { bcryptHash } from '../../src/main/mail-bcrypt.js';
import { MailService } from '../../src/main/mail-service.js';
import { mailTools, mailToolPort } from '../../src/main/mcp-tools-mail.js';
import type { Caller, Registration } from '../../src/main/mcp-tools.js';
import { MAILPIT_MEASURED_IMAGE } from './mailpit-image.js';

/**
 * GENIE MAIL G6 AGAINST THE REAL MAILPIT (Tynn story #492): the `mail` tool, composed as the host composes it (the inbox
 * book, the shared Mailpit reading it, its API on loopback), driven by two workspaces' agents.
 *   1. A creates an inbox; the SMTP credentials the tool answers authenticate and send, to B's default inbox.
 *   2. B lists and reads that message: text, HTML, headers, attachment metadata.
 *   3. A message A SENT to an outside address is A's to read (Mailpit's Username, on a closed send API) and refused to B.
 *   4. B deletes its message; A rotates its inbox (the old password refused, the new one accepted) and deletes it.
 */
const run = promisify(execFile);
const docker = async (...args: string[]) => (await run('docker', args, { maxBuffer: 16 * 1024 * 1024 })).stdout.trim();
const finding = (name: string, value: unknown) => { console.log(`MAILPIT_FINDING ${name} ${JSON.stringify(value)}`); };
const SEND_API = { user: 'genie', password: 'G6SendApi-0001' };
const callers: Record<string, Caller> = {
    'term-a': { agentId: 'agent-a', workspaceId: 'ws-a', workspacePath: '/w/a' } as Caller,
    'term-b': { agentId: 'agent-b', workspaceId: 'ws-b', workspacePath: '/w/b' } as Caller,
};

let dir = '';
let name = '';
let volume = '';
let smtpPort = 0;
let httpPort = 0;
let tool: Registration;
const secrets = new Map<string, string>();

async function ready(): Promise<void> {
    // Read the published ports every time: a restarted container may be given new ones.
    const port = async (p: string) => Number(/:(\d+)\s*$/m.exec(await docker('port', name, p))![1]);
    smtpPort = await port('1025/tcp');
    httpPort = await port('8025/tcp');
    for (let i = 0; i < 120; i++) {
        try { if ((await fetch(`http://127.0.0.1:${httpPort}/readyz`)).ok) return; } catch { /* not listening yet */ }
        await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error(`Mailpit did not become ready: ${await docker('logs', name).catch(() => '')}`);
}

/** Authenticate and send one message; the reply to AUTH, and to the end of DATA when AUTH was accepted. */
async function send(user: string, password: string, rcpt: readonly string[], message: string): Promise<{ auth: string; data?: string }> {
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
    const line = async (text: string) => { socket.write(`${text}\r\n`); return reply(); };
    try {
        await reply();
        await line('EHLO genie-g6.test');
        const auth = await line(`AUTH PLAIN ${Buffer.from(`\0${user}\0${password}`).toString('base64')}`);
        if (!auth.startsWith('235')) return { auth };
        await line(`MAIL FROM:<${user}>`);
        for (const r of rcpt) await line(`RCPT TO:<${r}>`);
        await line('DATA');
        return { auth, data: await line(`${message}\r\n.`) };
    } finally {
        socket.end();
    }
}
const code = (reply: string | undefined) => Number((reply ?? '').slice(0, 3));

const call = async (terminalId: string, args: JsonObject) => {
    const r = await tool.handler({ ...args, terminalId }, { server: 'genie', tool: 'mail', headers: {} });
    return { isError: r.isError === true, body: JSON.parse(r.text) as Record<string, any> };
};
/** The caller's messages, waiting for one with this subject to arrive. */
async function arrived(terminalId: string, subject: string): Promise<Record<string, any>> {
    for (let i = 0; i < 60; i++) {
        const r = await call(terminalId, { action: 'messages' });
        const m = (r.body.messages ?? []).find((x: { subject: string }) => x.subject === subject);
        if (m) return m;
        await new Promise((res) => setTimeout(res, 250));
    }
    throw new Error(`${subject} never arrived for ${terminalId}`);
}

const helloMessage = [
    'From: signup@ws-a.mail.gen', 'To: app@ws-b.mail.gen', 'Subject: G6 hello', 'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="g6mixed"', '',
    '--g6mixed', 'Content-Type: multipart/alternative; boundary="g6alt"', '',
    '--g6alt', 'Content-Type: text/plain; charset=utf-8', '', 'Hello from G6', '',
    '--g6alt', 'Content-Type: text/html; charset=utf-8', '', '<p>Hello from <a href="https://example.test/verify">G6</a></p>', '',
    '--g6alt--', '',
    '--g6mixed', 'Content-Type: application/pdf; name="invoice.pdf"', 'Content-Disposition: attachment; filename="invoice.pdf"', 'Content-Transfer-Encoding: base64', '',
    'JVBERi0xLjQKJUVPRgo=', '',
    '--g6mixed--',
].join('\r\n');
const sentOnlyMessage = ['From: app@ws-a.mail.gen', 'To: someone@example.test', 'Subject: G6 sent only', 'MIME-Version: 1.0', 'Content-Type: text/plain; charset=utf-8', '', 'to the outside'].join('\r\n');

beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'genie-mail-g6-'));
    name = `genie-mail-g6-${process.pid}`;
    volume = `genie-mail-g6-data-${process.pid}`;
    await docker('pull', MAILPIT_MEASURED_IMAGE);
    const plan = containerPlan({ engine: 'mailpit', major: '1.30', scope: { kind: 'shared' }, publishedPort: 1, surfacePorts: { ui: 2 }, credentials: SEND_API, smtpAuthDir: join(dir, 'mailpit-auth') });
    // The book exists (empty) before Mailpit starts, as the host opens it first.
    const service = await MailService.open({
        storeFile: join(dir, 'mail-inboxes.json'),
        authDir: join(dir, 'mailpit-auth'),
        hash: bcryptHash,
        secrets: { get: async (n) => secrets.get(n) ?? null, set: async (n, v) => { secrets.set(n, v); return true; } },
        attachedWorkspaces: () => ['ws-a', 'ws-b'],
        wired: () => true,
        wire: async () => {},
        restart: async () => { await docker('restart', name); await ready(); },
        envChanged: () => {},
    });
    await docker('run', '-d', '--name', name, '-p', '127.0.0.1::1025', '-p', '127.0.0.1::8025', '-v', `${volume}:/data`,
        ...(plan.mounts ?? []).flatMap((m) => ['-v', `${m.source}:${m.target}:ro`]),
        ...Object.entries(plan.env).flatMap(([k, v]) => ['-e', `${k}=${v}`]),
        MAILPIT_MEASURED_IMAGE);
    await ready();
    await service.sync();
    [tool] = mailTools({
        resolveCaller: (id) => callers[id] ?? null,
        mail: mailToolPort({ service, envFor: () => ({ MAIL_MAILER: 'smtp', MAIL_HOST: '127.0.0.1', MAIL_PORT: String(smtpPort) }), apiUrl: () => `http://127.0.0.1:${httpPort}` }),
    }) as [Registration];
}, 180_000);

afterAll(async () => {
    if (name) await docker('rm', '-f', name).catch(() => '');
    if (volume) await docker('volume', 'rm', '-f', volume).catch(() => '');
    if (dir) rmSync(dir, { recursive: true, force: true });
});

describe('the mail tool on the real Mailpit, two workspaces', () => {
    let signup: { user: string; password: string; port: number; host: string };
    let helloId = '';
    let sentOnlyId = '';

    it('A creates an inbox; the credentials the tool answers send through the real Mailpit', async () => {
        const made = await call('term-a', { action: 'create', name: 'signup' });
        finding('g6-create', { ...made.body, smtp: { ...made.body.smtp, password: made.body.smtp?.password ? '(given)' : '(missing)' } });
        expect(made.isError).toBe(false);
        expect(made.body.inbox).toMatchObject({ name: 'signup', address: 'signup@ws-a.mail.gen' });
        expect(made.body.smtp).toMatchObject({ host: '127.0.0.1', port: smtpPort, user: 'signup@ws-a.mail.gen' });
        signup = made.body.smtp;
        const sent = await send(signup.user, signup.password, ['app@ws-b.mail.gen'], helloMessage);
        finding('g6-send', sent);
        expect(code(sent.auth)).toBe(235);
        expect(code(sent.data)).toBe(250);
    });

    it('B lists and reads it: text, HTML, headers and attachment metadata', async () => {
        const listed = await arrived('term-b', 'G6 hello');
        helloId = listed.id;
        const read = await call('term-b', { action: 'read', id: helloId });
        finding('g6-read', { listed, read: { ...read.body.message, html: read.body.message?.html?.slice(0, 80), headers: Object.keys(read.body.message?.headers ?? {}) } });
        expect(listed).toMatchObject({ from: 'signup@ws-a.mail.gen', to: ['app@ws-b.mail.gen'], inboxes: ['app'], attachments: 1 });
        expect(listed).not.toHaveProperty('text');
        expect(read.body.message).toMatchObject({ id: helloId, subject: 'G6 hello', inboxes: ['app'], attachments: [{ fileName: 'invoice.pdf', contentType: 'application/pdf' }] });
        expect(read.body.message.text).toContain('Hello from G6');
        expect(read.body.message.html).toContain('https://example.test/verify');
        expect(read.body.message.headers.Subject).toEqual(['G6 hello']);
    });

    it('a message A sent to the outside is A\'s to read, and B is refused it by name', async () => {
        const app = await call('term-a', { action: 'list' });
        expect(app.body.inboxes.map((i: { name: string }) => i.name)).toEqual(['app', 'signup']);
        // A's default inbox's password is the one its env carries (G5): the keychain's.
        const appInbox = app.body.inboxes.find((i: { name: string }) => i.name === 'app');
        const sent = await send('app@ws-a.mail.gen', secrets.get(`mail/inbox/${appInbox.id}`)!, ['someone@example.test'], sentOnlyMessage);
        expect(code(sent.data)).toBe(250);
        const mine = await arrived('term-a', 'G6 sent only');
        sentOnlyId = mine.id;
        const byA = await call('term-a', { action: 'read', id: sentOnlyId });
        const byB = await call('term-b', { action: 'read', id: sentOnlyId });
        finding('g6-sent-only', { listedForA: mine, aRead: byA.isError ? byA.body.error : 'read', bRead: byB.body.error ?? 'READ (leak)' });
        expect(byA.isError).toBe(false);
        expect(byA.body.message.text).toContain('to the outside');
        expect(byB.isError).toBe(true);
        expect(byB.body.error).toContain(`${sentOnlyId} is not in this workspace`);
        expect(JSON.stringify(byB.body)).not.toContain('to the outside');
    });

    it('B deletes its message; A rotates its inbox (the old password refused) and deletes it (its user refused)', async () => {
        const deleted = await call('term-b', { action: 'delete', id: helloId });
        expect(deleted.body).toMatchObject({ ok: true, deleted: helloId });
        const left = await call('term-b', { action: 'messages' });
        expect(left.body.messages.map((m: { id: string }) => m.id)).not.toContain(helloId);

        const rotated = await call('term-a', { action: 'rotate', inbox: 'signup' });
        expect(rotated.isError).toBe(false);
        const oldPw = await send(signup.user, signup.password, ['app@ws-b.mail.gen'], helloMessage);
        const newPw = await send(signup.user, rotated.body.smtp.password, ['app@ws-b.mail.gen'], helloMessage);
        const gone = await call('term-a', { action: 'delete', inbox: 'signup' });
        const afterDelete = await send(signup.user, rotated.body.smtp.password, ['app@ws-b.mail.gen'], helloMessage);
        finding('g6-rotate-delete', { oldPassword: oldPw.auth, newPassword: newPw.auth, deleted: gone.body, afterDelete: afterDelete.auth });
        expect(code(oldPw.auth)).toBe(535);
        expect(code(newPw.auth)).toBe(235);
        expect(gone.body).toMatchObject({ ok: true, deletedInbox: 'signup@ws-a.mail.gen' });
        expect(code(afterDelete.auth)).toBe(535);
    });
});
