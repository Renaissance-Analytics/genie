import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { connect, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { containerPlan } from '../../src/core/services.js';
import { bcryptHash } from '../../src/main/mail-bcrypt.js';
import { MailHost } from '../../src/main/mail-host.js';
import { MAILPIT_MEASURED_IMAGE } from './mailpit-image.js';

/**
 * GENIE MAIL G3 AGAINST THE REAL MAILPIT (Tynn story #489): the host's inbox book writes Mailpit's SMTP auth file and
 * restarts Mailpit (G1's finding 7: the file is read only at start), and the real image then answers:
 *   - an inbox's password, as `create` returned it, authenticates its own SMTP user, and not another inbox's;
 *   - after `rotate`, the old password is refused and the new one authenticates;
 *   - after `delete`, the inbox's password is refused.
 * Mailpit runs with the env and mounts Genie's own plan gives it (containerPlan with the auth directory), and the restart
 * is the one the host does: the container's. Plus what an EMPTY book means to Mailpit, which G5 must know.
 */
const run = promisify(execFile);
const docker = async (...args: string[]) => (await run('docker', args, { maxBuffer: 16 * 1024 * 1024 })).stdout.trim();
const finding = (name: string, value: unknown) => { console.log(`MAILPIT_FINDING ${name} ${JSON.stringify(value)}`); };

let dir = '';
let name = '';
let smtpPort = 0;
let httpPort = 0;
let host: MailHost;

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

/** EHLO, then AUTH PLAIN (or no AUTH) and MAIL FROM: the replies Mailpit gives. */
async function smtp(user?: string, password?: string): Promise<{ auth?: string; mail: string }> {
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
        await send('EHLO genie-g3.test');
        const auth = user !== undefined ? await send(`AUTH PLAIN ${Buffer.from(`\0${user}\0${password ?? ''}`).toString('base64')}`) : undefined;
        const mail = await send('MAIL FROM:<app@example-a.mail.gen>');
        return { ...(auth !== undefined ? { auth } : {}), mail };
    } finally {
        socket.end();
    }
}
const code = (reply: string | undefined) => Number((reply ?? '').slice(0, 3));

beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'genie-mail-g3-'));
    name = `genie-mail-g3-${process.pid}`;
    host = await MailHost.open({
        storeFile: join(dir, 'mail-inboxes.json'),
        authDir: join(dir, 'mailpit-auth'),
        hash: bcryptHash,
        randomPassword: () => `G3-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}-genie`,
        now: Date.now,
        restartMailpit: async () => { await docker('restart', name); await ready(); },
    });
    const plan = containerPlan({ engine: 'mailpit', major: '1.30', scope: { kind: 'shared' }, publishedPort: 1, surfacePorts: { ui: 2 }, credentials: { user: 'genie', password: 'G3SendApi-0001' }, smtpAuthDir: join(dir, 'mailpit-auth') });
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

describe('the inbox book against the real Mailpit', () => {
    it('an empty book: what Mailpit does with an auth file that names nobody (recorded for G5)', async () => {
        const none = await smtp();
        finding('g3-empty-book', { noAuthMailFrom: none.mail });
        // Measured, not assumed: Mailpit reads an empty file as "no credentials", so it requires no auth at all.
        expect(code(none.mail)).toBe(250);
    });

    it('create: the returned password authenticates its own inbox, not another\'s; no auth is refused', async () => {
        const a = await host.create({ workspaceId: 'ws-a', workspaceSlug: 'example-a', name: 'signup' });
        const b = await host.create({ workspaceId: 'ws-b', workspaceSlug: 'example-b', name: 'signup' });
        const aOwn = await smtp(a.inbox.smtpUser, a.password);
        const bWithA = await smtp(b.inbox.smtpUser, a.password);
        const none = await smtp();
        finding('g3-create', { own: aOwn.auth, otherInboxWithThisPassword: bWithA.auth, noAuth: none.mail });
        expect(code(aOwn.auth)).toBe(235);
        expect(code(aOwn.mail)).toBe(250);
        expect(code(bWithA.auth)).toBe(535);
        expect(code(none.mail)).toBe(530);
    });

    it('rotate: the old password is refused and the new one authenticates; delete: refused', async () => {
        const inbox = host.list('ws-a').find((i) => i.name === 'signup')!;
        const first = await host.rotate(inbox.id);
        const second = await host.rotate(inbox.id);
        const old = await smtp(inbox.smtpUser, first.password);
        const next = await smtp(inbox.smtpUser, second.password);
        finding('g3-rotate', { old: old.auth, new: next.auth });
        expect(code(old.auth)).toBe(535);
        expect(code(next.auth)).toBe(235);
        await host.remove(inbox.id);
        const gone = await smtp(inbox.smtpUser, second.password);
        const other = host.list('ws-b')[0]!;
        finding('g3-delete', { deleted: gone.auth, remainingInboxes: host.list().map((i) => i.smtpUser), otherSmtpUser: other.smtpUser });
        expect(code(gone.auth)).toBe(535);
    });
});
