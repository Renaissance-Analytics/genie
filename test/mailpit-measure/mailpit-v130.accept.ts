import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { connect, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MAILPIT_MEASURED_IMAGE } from './mailpit-image.js';

/**
 * GENIE MAIL G1 — MEASURE MAILPIT v1.30 BEFORE GENIE RELIES ON IT (Tynn story #487, spec .ai/plans/specs/genie-mail.md).
 *
 * A proposed mechanism is a hypothesis. Genie Mail (G3-G9) plans to rely on six Mailpit behaviours; each is measured here
 * against the REAL image Genie runs (`axllent/mailpit:v1.30`, pulled from GHCR by digest — the same manifest as Docker
 * Hub's, see mailpit-image.ts), in a throwaway container on CI's Linux job. Never on a person's desktop: this file is
 * `*.accept.ts`, outside `npm test`, and only `npm run verify:mailpit` (the `mailpit measure` CI job) runs it.
 *
 *   1. an SMTP auth file with two users: each user's own password, and no other, authenticates;
 *   2. a message carries the SMTP username it was sent with (its `Username`, and a tag with MP_TAGS_USERNAME);
 *   3. the websocket (`/api/events`) reports a new message;
 *   4. the HTML check answers per-client support for a message;
 *   5. the link check answers each link's status, and does not reach an internal address by default;
 *   6. the send API delivers a message, and what it records as the username.
 * Plus what G3's `rotate` must know: whether Mailpit reads its auth file again without a restart.
 *
 * Every Mailpit answer the findings rest on is printed as `MAILPIT_FINDING <name> <json>`, so the PR quotes Mailpit's own
 * responses, not a summary of them. The passwords are test-only constants; the hashes are bcrypt (cost 10) of them.
 */
const run = promisify(execFile);
const docker = async (...args: string[]) => (await run('docker', args, { maxBuffer: 16 * 1024 * 1024 })).stdout.trim();
const finding = (name: string, value: unknown) => { console.log(`MAILPIT_FINDING ${name} ${JSON.stringify(value)}`); };

const USERS = {
    alpha: { password: 'alpha-test-password-1', hash: '$2y$10$MYiSlZ4KhqIp1uW5x2VgkuLKgyBSKHC.iqTcNAHil8mkl/nx6uGhS' },
    bravo: { password: 'bravo-test-password-2', hash: '$2b$10$tT7WdeL05z3o2fcx7Y9wSefRXPTW0YyyXb94fVjryiv98mI25WkR2' },
} as const;
const ROTATED = { password: 'alpha-test-password-rotated', hash: '$2b$10$zAHq5JIxgowxEZEXmwAMaOLhEf5tmHdX2FJNIXRiVTqjaHSjMWbDq' };
const authFile = (alphaHash: string) => `alpha:${alphaHash}\nbravo:${USERS.bravo.hash}\n`;

let dir = '';
let name = '';
let smtpPort = 0;
let httpPort = 0;
const api = (path: string, init?: RequestInit) => fetch(`http://127.0.0.1:${httpPort}${path}`, init);

async function ready(): Promise<void> {
    for (let i = 0; i < 120; i++) {
        try { if ((await api('/readyz')).ok) return; } catch { /* not listening yet */ }
        await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error(`Mailpit did not become ready: ${await docker('logs', name).catch(() => '')}`);
}
async function ports(): Promise<void> {
    const port = async (p: string) => Number(/:(\d+)\s*$/m.exec(await docker('port', name, p))![1]);
    smtpPort = await port('1025/tcp');
    httpPort = await port('8025/tcp');
}

// ── A minimal SMTP client: one reply per command, multi-line replies read whole ─────────────────────────────────────

class Smtp {
    readonly #socket: Socket;
    #buffer = '';
    #waiters: Array<() => void> = [];
    private constructor(socket: Socket) {
        this.#socket = socket;
        socket.setEncoding('utf8');
        socket.on('data', (d: string) => { this.#buffer += d; for (const w of this.#waiters.splice(0)) w(); });
    }
    static async open(port: number): Promise<{ smtp: Smtp; greeting: string }> {
        const socket = await new Promise<Socket>((ok, fail) => { const s = connect(port, '127.0.0.1', () => ok(s)); s.once('error', fail); });
        const smtp = new Smtp(socket);
        return { smtp, greeting: await smtp.reply() };
    }
    /** The next whole reply: lines `NNN-…` up to the `NNN …` line. */
    async reply(): Promise<string> {
        for (;;) {
            const m = /^(?:\d{3}-[^\r\n]*\r\n)*\d{3}(?: [^\r\n]*)?\r\n/.exec(this.#buffer);
            if (m) { this.#buffer = this.#buffer.slice(m[0].length); return m[0].trimEnd(); }
            await new Promise<void>((r) => { this.#waiters.push(r); setTimeout(r, 5000); });
        }
    }
    async send(line: string): Promise<string> { this.#socket.write(`${line}\r\n`); return this.reply(); }
    close(): void { this.#socket.end(); }
}
/** A reply's code: its last line's first three digits. */
const code = (reply: string) => Number(reply.split('\r\n').at(-1)!.slice(0, 3));
const plain = (user: string, password: string) => Buffer.from(`\0${user}\0${password}`).toString('base64');

/** Authenticate (or not) and send one message; answers each step's reply. */
async function sendMail(input: { user?: string; password?: string; from: string; to: string; subject: string; body: string; contentType?: string }) {
    const { smtp, greeting } = await Smtp.open(smtpPort);
    const out: Record<string, string> = { greeting };
    try {
        out.ehlo = await smtp.send('EHLO genie-measure.test');
        if (input.user !== undefined) {
            out.auth = await smtp.send(`AUTH PLAIN ${plain(input.user, input.password ?? '')}`);
            if (code(out.auth) !== 235) return out;
        }
        out.mail = await smtp.send(`MAIL FROM:<${input.from}>`);
        if (code(out.mail) !== 250) return out;
        out.rcpt = await smtp.send(`RCPT TO:<${input.to}>`);
        out.data = await smtp.send('DATA');
        const message = [
            `From: <${input.from}>`, `To: <${input.to}>`, `Subject: ${input.subject}`, `Message-ID: <${input.subject.replace(/\W+/g, '-')}@genie-measure.test>`,
            'MIME-Version: 1.0', `Content-Type: ${input.contentType ?? 'text/plain; charset=utf-8'}`, '', input.body,
        ].join('\r\n');
        out.sent = await smtp.send(`${message}\r\n.`);
        await smtp.send('QUIT').catch(() => '');
        return out;
    } finally {
        smtp.close();
    }
}

interface Summary { ID: string; Subject: string; Username?: string; Tags?: string[] }
async function findBySubject(subject: string): Promise<Summary> {
    for (let i = 0; i < 40; i++) {
        const r = await (await api(`/api/v1/search?query=${encodeURIComponent(`subject:"${subject}"`)}`)).json() as { messages: Summary[] };
        const m = r.messages.find((x) => x.Subject === subject);
        if (m) return m;
        await new Promise((res) => setTimeout(res, 100));
    }
    throw new Error(`no message "${subject}"`);
}

beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'genie-mailpit-measure-'));
    writeFileSync(join(dir, 'smtp.htpasswd'), authFile(USERS.alpha.hash));
    name = `genie-mailpit-measure-${process.pid}`;
    await docker('pull', MAILPIT_MEASURED_IMAGE);
    await docker('run', '-d', '--name', name,
        '-p', '127.0.0.1::1025', '-p', '127.0.0.1::8025',
        '-v', `${dir}:/auth:ro`,
        '-e', 'MP_SMTP_AUTH_FILE=/auth/smtp.htpasswd',
        '-e', 'MP_SMTP_AUTH_ALLOW_INSECURE=true',
        '-e', 'MP_TAGS_USERNAME=true',
        MAILPIT_MEASURED_IMAGE);
    await ports();
    await ready();
    finding('info', await (await api('/api/v1/info')).json());
}, 180_000);

afterAll(async () => {
    if (name) await docker('rm', '-f', name).catch(() => '');
    if (dir) rmSync(dir, { recursive: true, force: true });
});

describe('Mailpit v1.30, measured', () => {
    it('1. an SMTP auth file with two users: each user\'s own password authenticates, the other\'s does not, and no auth is refused', async () => {
        const aWithA = await sendMail({ user: 'alpha', password: USERS.alpha.password, from: 'app@alpha.mail.gen', to: 'signup@alpha.mail.gen', subject: 'G1 alpha own password', body: 'hello' });
        const bWithB = await sendMail({ user: 'bravo', password: USERS.bravo.password, from: 'app@bravo.mail.gen', to: 'signup@bravo.mail.gen', subject: 'G1 bravo own password', body: 'hello' });
        const bWithA = await sendMail({ user: 'bravo', password: USERS.alpha.password, from: 'app@bravo.mail.gen', to: 'signup@bravo.mail.gen', subject: 'G1 bravo with alpha password', body: 'hello' });
        const none = await sendMail({ from: 'app@alpha.mail.gen', to: 'signup@alpha.mail.gen', subject: 'G1 no auth', body: 'hello' });
        finding('smtp-auth', { alphaWithAlpha: aWithA.auth, bravoWithBravo: bWithB.auth, bravoWithAlphasPassword: bWithA.auth, ehlo: aWithA.ehlo, noAuthMailFrom: none.mail });
        // Positive controls: both hash forms ($2y$ and $2b$) authenticate their own user, and the message is accepted.
        expect(code(aWithA.auth!)).toBe(235);
        expect(code(aWithA.sent!)).toBe(250);
        expect(code(bWithB.auth!)).toBe(235);
        // The claim: A's password is refused for B.
        expect(code(bWithA.auth!)).toBe(535);
        // And an unauthenticated sender is refused before any recipient.
        expect(code(none.mail!)).toBe(530);
        expect(none.rcpt).toBeUndefined();
    });

    it('2. a message carries the SMTP username it was sent with: its Username, and a tag of it', async () => {
        await sendMail({ user: 'alpha', password: USERS.alpha.password, from: 'app@alpha.mail.gen', to: 'someone@bravo.mail.gen', subject: 'G1 tag alpha', body: 'tagged' });
        await sendMail({ user: 'bravo', password: USERS.bravo.password, from: 'app@bravo.mail.gen', to: 'someone@alpha.mail.gen', subject: 'G1 tag bravo', body: 'tagged' });
        const a = await findBySubject('G1 tag alpha');
        const b = await findBySubject('G1 tag bravo');
        finding('username-tag', { alpha: { Username: a.Username, Tags: a.Tags }, bravo: { Username: b.Username, Tags: b.Tags } });
        expect(a.Username).toBe('alpha');
        expect(a.Tags).toContain('alpha');
        expect(a.Tags).not.toContain('bravo');
        expect(b.Username).toBe('bravo');
        expect(b.Tags).toContain('bravo');
        expect(b.Tags).not.toContain('alpha');
    });

    it('3. the websocket reports a new message, with its summary', async () => {
        const events: Array<{ Type: string; Data: Summary }> = [];
        const ws = new WebSocket(`ws://127.0.0.1:${httpPort}/api/events`);
        await new Promise<void>((ok, fail) => { ws.addEventListener('open', () => ok()); ws.addEventListener('error', () => fail(new Error('websocket did not open'))); });
        ws.addEventListener('message', (e) => { try { events.push(JSON.parse(String(e.data))); } catch { /* not JSON */ } });
        await sendMail({ user: 'alpha', password: USERS.alpha.password, from: 'app@alpha.mail.gen', to: 'signup@alpha.mail.gen', subject: 'G1 websocket', body: 'live' });
        let event: { Type: string; Data: Summary } | undefined;
        for (let i = 0; i < 50 && !event; i++) { event = events.find((e) => e.Type === 'new' && e.Data?.Subject === 'G1 websocket'); if (!event) await new Promise((r) => setTimeout(r, 100)); }
        ws.close();
        finding('websocket', { types: [...new Set(events.map((e) => e.Type))], newEvent: event });
        expect(event).toBeDefined();
        expect(event!.Data).toMatchObject({ Subject: 'G1 websocket', Username: 'alpha' });
        expect(event!.Data.ID).toMatch(/\S/);
    });

    it('4. the HTML check answers per-client support, with a score', async () => {
        const html = '<html><head><style>.c{display:flex}</style></head><body><div class="c"><img src="https://example.com/a.png"><p>Hi</p></div></body></html>';
        await sendMail({ user: 'alpha', password: USERS.alpha.password, from: 'app@alpha.mail.gen', to: 'signup@alpha.mail.gen', subject: 'G1 html check', body: html, contentType: 'text/html; charset=utf-8' });
        const m = await findBySubject('G1 html check');
        const res = await api(`/api/v1/message/${m.ID}/html-check`);
        const body = await res.json() as { Total?: Record<string, number>; Warnings?: Array<{ Slug: string; Title: string; Category: string; Score: Record<string, number>; Results: Array<{ Family: string; Name: string; Support: string }> }>; Platforms?: Record<string, string[]> };
        finding('html-check', { status: res.status, Total: body.Total, Platforms: body.Platforms, Warnings: (body.Warnings ?? []).map((w) => ({ Slug: w.Slug, Title: w.Title, Category: w.Category, Score: w.Score, families: [...new Set(w.Results.map((r) => r.Family))] })) });
        expect(res.status).toBe(200);
        expect(body.Total!.Tests).toBeGreaterThan(0);
        expect((body.Warnings ?? []).length).toBeGreaterThan(0);
        expect(Object.keys(body.Platforms ?? {}).length).toBeGreaterThan(0);
    });

    it('5. the link check answers each link\'s status, and does not reach an internal address', async () => {
        const html = '<html><body><a href="https://example.com/">ok</a> <a href="http://127.0.0.1:9/private">internal</a> <a href="https://genie-measure-nowhere.invalid/">nowhere</a></body></html>';
        await sendMail({ user: 'alpha', password: USERS.alpha.password, from: 'app@alpha.mail.gen', to: 'signup@alpha.mail.gen', subject: 'G1 link check', body: html, contentType: 'text/html; charset=utf-8' });
        const m = await findBySubject('G1 link check');
        const res = await api(`/api/v1/message/${m.ID}/link-check`);
        const body = await res.json() as { Errors?: number; Links?: Array<{ URL: string; StatusCode: number; Status: string }> };
        finding('link-check', { status: res.status, body });
        expect(res.status).toBe(200);
        const byUrl = new Map((body.Links ?? []).map((l) => [l.URL, l]));
        expect([...byUrl.keys()].sort()).toEqual(['http://127.0.0.1:9/private', 'https://example.com/', 'https://genie-measure-nowhere.invalid/']);
        expect(byUrl.get('https://example.com/')!.StatusCode).toBe(200);
        // Not reached: no 2xx for the internal address or the unresolvable one.
        for (const url of ['http://127.0.0.1:9/private', 'https://genie-measure-nowhere.invalid/']) expect(byUrl.get(url)!.StatusCode < 200 || byUrl.get(url)!.StatusCode >= 300).toBe(true);
        expect(body.Errors).toBeGreaterThanOrEqual(2);
    });

    it('6. the send API delivers a message; with no send-API auth configured it records a Basic user it never checked', async () => {
        const res = await api('/api/v1/send', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Basic ${Buffer.from('alpha:not-the-password').toString('base64')}` },
            body: JSON.stringify({ From: { Email: 'app@alpha.mail.gen' }, To: [{ Email: 'signup@alpha.mail.gen' }], Subject: 'G1 send api', Text: 'sent by API' }),
        });
        const body = await res.json() as { ID?: string };
        const m = await findBySubject('G1 send api');
        finding('send-api', { status: res.status, body, summary: { Username: m.Username, Tags: m.Tags } });
        expect(res.status).toBe(200);
        expect(body.ID).toBe(m.ID);
        // The measured hazard for G4: an unverified Basic user is recorded as the Username — so routing must not trust a
        // Username on mail that did not come in over authenticated SMTP, or the send API must be closed or given its own auth.
        expect(m.Username).toBe('alpha');
    });

    it('7. the auth file is read at start: a changed password applies only after a restart (G3\'s rotate)', async () => {
        writeFileSync(join(dir, 'smtp.htpasswd'), authFile(ROTATED.hash));
        await new Promise((r) => setTimeout(r, 1500));
        const oldBefore = await sendMail({ user: 'alpha', password: USERS.alpha.password, from: 'app@alpha.mail.gen', to: 'x@alpha.mail.gen', subject: 'G1 rotate old before restart', body: 'x' });
        const newBefore = await sendMail({ user: 'alpha', password: ROTATED.password, from: 'app@alpha.mail.gen', to: 'x@alpha.mail.gen', subject: 'G1 rotate new before restart', body: 'x' });
        await docker('restart', name);
        await ports();
        await ready();
        const oldAfter = await sendMail({ user: 'alpha', password: USERS.alpha.password, from: 'app@alpha.mail.gen', to: 'x@alpha.mail.gen', subject: 'G1 rotate old after restart', body: 'x' });
        const newAfter = await sendMail({ user: 'alpha', password: ROTATED.password, from: 'app@alpha.mail.gen', to: 'x@alpha.mail.gen', subject: 'G1 rotate new after restart', body: 'x' });
        finding('auth-file-reload', { beforeRestart: { old: oldBefore.auth, new: newBefore.auth }, afterRestart: { old: oldAfter.auth, new: newAfter.auth } });
        expect(code(oldBefore.auth!)).toBe(235);
        expect(code(newBefore.auth!)).toBe(535);
        expect(code(oldAfter.auth!)).toBe(535);
        expect(code(newAfter.auth!)).toBe(235);
    });
});
