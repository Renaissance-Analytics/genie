import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { connect, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { containerPlan } from '../../src/core/services.js';
import { bcryptHash } from '../../src/main/mail-bcrypt.js';
import { MailService } from '../../src/main/mail-service.js';
import { MAILPIT_MEASURED_IMAGE } from './mailpit-image.js';

/**
 * GENIE MAIL G5 AGAINST THE REAL MAILPIT (Tynn story #491): the live shared Mailpit goes from "no book" to "reading the
 * book" with every workspace's credentials in place first, so no app is refused along the way.
 *   1. Before: the pre-G5 Mailpit (Genie's plan without the auth directory) takes mail with no credentials, as apps send today.
 *   2. MailService.sync makes each attached workspace's default inbox, then wires Mailpit to the book: the container is
 *      recreated from Genie's plan WITH the auth directory, on the same data volume.
 *   3. After: each workspace's credentials, as its env would carry them, authenticate and send; sending without credentials
 *      is the only thing refused (530).
 */
const run = promisify(execFile);
const docker = async (...args: string[]) => (await run('docker', args, { maxBuffer: 16 * 1024 * 1024 })).stdout.trim();
const finding = (name: string, value: unknown) => { console.log(`MAILPIT_FINDING ${name} ${JSON.stringify(value)}`); };
const SEND_API = { user: 'genie', password: 'G5SendApi-0001' };

let dir = '';
let name = '';
let volume = '';
let smtpPort = 0;
let httpPort = 0;
const secrets = new Map<string, string>();
let service: MailService;

async function startFrom(withBook: boolean): Promise<void> {
    const plan = containerPlan({ engine: 'mailpit', major: '1.30', scope: { kind: 'shared' }, publishedPort: 1, surfacePorts: { ui: 2 }, credentials: SEND_API, ...(withBook ? { smtpAuthDir: join(dir, 'mailpit-auth') } : {}) });
    await docker('run', '-d', '--name', name, '-p', '127.0.0.1::1025', '-p', '127.0.0.1::8025', '-v', `${volume}:/data`,
        ...(plan.mounts ?? []).flatMap((m) => ['-v', `${m.source}:${m.target}:ro`]),
        ...Object.entries(plan.env).flatMap(([k, v]) => ['-e', `${k}=${v}`]),
        MAILPIT_MEASURED_IMAGE);
    const port = async (p: string) => Number(/:(\d+)\s*$/m.exec(await docker('port', name, p))![1]);
    smtpPort = await port('1025/tcp');
    httpPort = await port('8025/tcp');
    for (let i = 0; i < 120; i++) {
        try { if ((await fetch(`http://127.0.0.1:${httpPort}/readyz`)).ok) return; } catch { /* not listening yet */ }
        await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error(`Mailpit did not become ready: ${await docker('logs', name).catch(() => '')}`);
}

/** Send one message, with or without AUTH: the reply to AUTH (if any) and to MAIL FROM. */
async function send(user?: string, password?: string): Promise<{ auth?: string; mail: string }> {
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
        await line('EHLO genie-g5.test');
        const auth = user !== undefined ? await line(`AUTH PLAIN ${Buffer.from(`\0${user}\0${password ?? ''}`).toString('base64')}`) : undefined;
        const mail = await line('MAIL FROM:<app@example.test>');
        return { ...(auth !== undefined ? { auth } : {}), mail };
    } finally {
        socket.end();
    }
}
const code = (reply: string | undefined) => Number((reply ?? '').slice(0, 3));

beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'genie-mail-g5-'));
    name = `genie-mail-g5-${process.pid}`;
    volume = `genie-mail-g5-data-${process.pid}`;
    await docker('pull', MAILPIT_MEASURED_IMAGE);
    let wired = false;
    service = await MailService.open({
        storeFile: join(dir, 'mail-inboxes.json'),
        authDir: join(dir, 'mailpit-auth'),
        hash: bcryptHash,
        now: Date.now,
        secrets: { get: async (n) => secrets.get(n) ?? null, set: async (n, v) => { secrets.set(n, v); return true; } },
        attachedWorkspaces: () => ['ws-a', 'ws-b'],
        wired: () => wired,
        // Wiring the live Mailpit, as the registry does it: the container recreated from the plan WITH the book, on its volume.
        wire: async () => { await docker('rm', '-f', name); await startFrom(true); wired = true; },
        restart: async () => { await docker('restart', name); },
        envChanged: () => {},
    });
    await startFrom(false);
}, 180_000);

afterAll(async () => {
    if (name) await docker('rm', '-f', name).catch(() => '');
    if (volume) await docker('volume', 'rm', '-f', volume).catch(() => '');
    if (dir) rmSync(dir, { recursive: true, force: true });
});

describe('the live shared Mailpit, wired to the book with every workspace\'s credentials first', () => {
    it('before: an app sends with no credentials, as today', async () => {
        const before = await send();
        finding('g5-before', { noCredentials: before.mail });
        expect(code(before.mail)).toBe(250);
    });

    it('after sync: each workspace\'s env credentials send; sending without credentials is the only thing refused', async () => {
        await service.sync();
        const a = service.credentialsFor('ws-a')!;
        const b = service.credentialsFor('ws-b')!;
        const sentA = await send(a.username, a.password);
        const sentB = await send(b.username, b.password);
        const crossed = await send(b.username, a.password);
        const none = await send();
        finding('g5-after', { a: { user: a.username, auth: sentA.auth, mail: sentA.mail }, b: { user: b.username, auth: sentB.auth, mail: sentB.mail }, crossed: crossed.auth, noCredentials: none.mail });
        expect(code(sentA.auth)).toBe(235);
        expect(code(sentA.mail)).toBe(250);
        expect(code(sentB.auth)).toBe(235);
        expect(code(sentB.mail)).toBe(250);
        expect(code(crossed.auth)).toBe(535);
        expect(code(none.mail)).toBe(530);
    });
});
