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
 * GENIE MAIL G7 AGAINST THE REAL MAILPIT (Tynn story #493): `mail wait`, composed as genie-host composes it, answered by
 * the host's subscription to the real Mailpit's websocket (/api/events).
 *   1. A waits; the matching mail is sent half a second later; the wait answers within a second of Mailpit taking it.
 *   2. A waits; a matching mail that is B's alone (B's app to B's own inbox) arrives; A's wait times out ("timed out",
 *      not an error). A mail A's app SENDS is A's (its Sent, G4) wherever it is addressed, and does answer A's wait: an
 *      app under test mails whatever address was typed into it.
 *   3. With nothing matching at all, it answers "timed out" at the timeout.
 */
const run = promisify(execFile);
const docker = async (...args: string[]) => (await run('docker', args, { maxBuffer: 16 * 1024 * 1024 })).stdout.trim();
const finding = (name: string, value: unknown) => { console.log(`MAILPIT_FINDING ${name} ${JSON.stringify(value)}`); };
const SEND_API = { user: 'genie', password: 'G7SendApi-0001' };
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
let service: MailService;

async function ready(): Promise<void> {
    const port = async (p: string) => Number(/:(\d+)\s*$/m.exec(await docker('port', name, p))![1]);
    smtpPort = await port('1025/tcp');
    httpPort = await port('8025/tcp');
    for (let i = 0; i < 120; i++) {
        try { if ((await fetch(`http://127.0.0.1:${httpPort}/readyz`)).ok) return; } catch { /* not listening yet */ }
        await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error(`Mailpit did not become ready: ${await docker('logs', name).catch(() => '')}`);
}

/** Authenticate as a workspace's default inbox and send one message; the reply to the end of DATA. */
async function sendAs(user: string, password: string, to: string, subject: string): Promise<string> {
    const socket = await new Promise<Socket>((ok, fail) => { const s = connect(smtpPort, '127.0.0.1', () => ok(s)); s.once('error', fail); });
    socket.setEncoding('utf8');
    let buffer = '';
    socket.on('data', (d: string) => { buffer += d; });
    const reply = async () => {
        for (let i = 0; i < 100; i++) {
            const m = /^(?:\d{3}-[^\r\n]*\r\n)*\d{3}(?: [^\r\n]*)?\r\n/.exec(buffer);
            if (m) { buffer = buffer.slice(m[0].length); return m[0].trimEnd().split('\r\n').at(-1)!; }
            await new Promise((r) => setTimeout(r, 20));
        }
        throw new Error('no SMTP reply');
    };
    const line = async (text: string) => { socket.write(`${text}\r\n`); return reply(); };
    try {
        await reply();
        await line('EHLO genie-g7.test');
        const auth = await line(`AUTH PLAIN ${Buffer.from(`\0${user}\0${password}`).toString('base64')}`);
        if (!auth.startsWith('235')) throw new Error(`auth refused: ${auth}`);
        await line(`MAIL FROM:<${user}>`);
        await line(`RCPT TO:<${to}>`);
        await line('DATA');
        return await line([`From: ${user}`, `To: ${to}`, `Subject: ${subject}`, 'MIME-Version: 1.0', 'Content-Type: text/plain; charset=utf-8', '', 'click the link', '.'].join('\r\n'));
    } finally {
        socket.end();
    }
}
const appOf = (ws: string) => {
    const c = service.credentialsFor(ws)!;
    return { user: c.username, password: c.password };
};
const call = async (terminalId: string, args: JsonObject) => {
    const r = await tool.handler({ ...args, terminalId }, { server: 'genie', tool: 'mail', headers: {} });
    return { isError: r.isError === true, body: JSON.parse(r.text) as Record<string, any> };
};

beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'genie-mail-g7-'));
    name = `genie-mail-g7-${process.pid}`;
    volume = `genie-mail-g7-data-${process.pid}`;
    await docker('pull', MAILPIT_MEASURED_IMAGE);
    const plan = containerPlan({ engine: 'mailpit', major: '1.30', scope: { kind: 'shared' }, publishedPort: 1, surfacePorts: { ui: 2 }, credentials: SEND_API, smtpAuthDir: join(dir, 'mailpit-auth') });
    service = await MailService.open({
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

describe('mail wait on the real Mailpit\'s websocket', () => {
    it('answers within a second of the matching message arriving', async () => {
        const waiting = call('term-a', { action: 'wait', inbox: 'app', match: 'confirm your email', timeoutSeconds: 20 });
        await new Promise((r) => setTimeout(r, 500));
        const b = appOf('ws-b');
        const queued = await sendAs(b.user, b.password, 'app@ws-a.mail.gen', 'G7 Confirm your email');
        const queuedAt = Date.now();
        const r = await waiting;
        const answeredAfterMs = Date.now() - queuedAt;
        finding('g7-wait', { queued, answeredAfterMs, answer: r.body });
        expect(code(queued)).toBe(250);
        expect(r.isError).toBe(false);
        expect(r.body).toMatchObject({ ok: true, message: { subject: 'G7 Confirm your email', inboxes: ['app'], from: 'app@ws-b.mail.gen' } });
        expect(answeredAfterMs).toBeLessThan(1000);
    });

    it('a matching message to ANOTHER workspace\'s inbox never satisfies the wait: it times out', async () => {
        const waiting = call('term-a', { action: 'wait', match: 'G7 reset', timeoutSeconds: 3 });
        await new Promise((r) => setTimeout(r, 500));
        // B's alone: B's app sends it to B's own inbox. (One A's app sent would be A's Sent mail, and A's to wait for.)
        const b = appOf('ws-b');
        const queued = await sendAs(b.user, b.password, 'app@ws-b.mail.gen', 'G7 reset your password');
        const r = await waiting;
        // CONTROL: B, whose inbox it was, does see it (its unread message, already there).
        const forB = await call('term-b', { action: 'wait', match: 'G7 reset', timeoutSeconds: 3 });
        finding('g7-other-workspace', { queued, a: r.body, b: forB.body.message?.subject ?? forB.body });
        expect(code(queued)).toBe(250);
        expect(r.isError).toBe(false);
        expect(r.body).toMatchObject({ ok: true, timedOut: true });
        expect(forB.body).toMatchObject({ ok: true, message: { subject: 'G7 reset your password' } });
    });

    it('with nothing matching, "timed out" at the timeout, not an error', async () => {
        const started = Date.now();
        const r = await call('term-a', { action: 'wait', match: 'nothing will ever say this', timeoutSeconds: 2 });
        const took = Date.now() - started;
        finding('g7-timeout', { took, answer: r.body });
        expect(r.isError).toBe(false);
        expect(r.body).toMatchObject({ ok: true, timedOut: true });
        expect(took).toBeGreaterThanOrEqual(1900);
        expect(took).toBeLessThan(4000);
    });
});
const code = (reply: string) => Number(reply.slice(0, 3));
