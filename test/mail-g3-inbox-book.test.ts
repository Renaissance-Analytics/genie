import { compare } from 'bcryptjs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { inboxAddress, inboxNameProblem, MAIL_INBOX_CAPS, MAILPIT_SMTP_AUTH_FILE, renderSmtpAuthFile } from '../src/core/mail.js';
import { containerPlan } from '../src/core/services.js';
import { bcryptHash } from '../src/main/mail-bcrypt.js';
import { MailHost } from '../src/main/mail-host.js';

/**
 * GENIE MAIL G3 (Tynn story #489, spec .ai/plans/specs/genie-mail.md): THE INBOX BOOK AND MAILPIT'S SMTP AUTH FILE, IN THE
 * HOST. An inbox is `{id, workspaceId, name, address <name>@<workspace>.mail.gen, smtpUser, createdAt}`. Its password is
 * generated, written bcrypt-hashed to Mailpit's SMTP auth file, returned ONCE, and never stored in clear or logged.
 *
 * G1's finding 7 (genie#1712, measured): Mailpit reads its auth file only at start. So every change to the book (create,
 * rotate, delete) writes the file and THEN restarts Mailpit; without the restart an old password keeps working and a new
 * one does not. The real Mailpit proves it end to end in test/mailpit-measure/mail-g3-inboxes.accept.ts.
 */
let dir: string;
let restarts: string[];
let events: string[];
let pw: number;
const open = (over: Partial<Parameters<typeof MailHost.open>[0]> = {}) => MailHost.open({
    storeFile: join(dir, 'mail-inboxes.json'),
    authDir: join(dir, 'mailpit-auth'),
    hash: bcryptHash,
    randomPassword: () => `GeniePw-${String(++pw).padStart(4, '0')}-abcdefghijklmnop`,
    now: () => 1_000,
    restartMailpit: async () => { restarts.push('restart'); events.push('restart'); },
    onWrite: (what) => { events.push(`write:${what}`); },
    ...over,
});
const authFile = () => readFile(join(dir, 'mailpit-auth', MAILPIT_SMTP_AUTH_FILE), 'utf8');

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'genie2-mail-g3-'));
    restarts = [];
    events = [];
    pw = 0;
});
afterEach(async () => {
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
});

describe('the pure model', () => {
    it('an inbox\'s address is <name>@<workspace>.mail.gen, and only a plain name is one', () => {
        expect(inboxAddress('signup', 'example-a')).toBe('signup@example-a.mail.gen');
        expect(inboxNameProblem('signup')).toBeNull();
        expect(inboxNameProblem('qa-2')).toBeNull();
        for (const bad of ['', 'Signup', '-x', 'a b', 'a@b', 'a:b', 'x'.repeat(33)]) expect(inboxNameProblem(bad), bad).toMatch(/inbox name/);
    });

    it('the auth file is one user:bcrypt line per inbox, sorted; the caps are decision 5\'s', () => {
        expect(renderSmtpAuthFile([{ smtpUser: 'b@w.mail.gen', hash: '$2b$10$bbb' }, { smtpUser: 'a@w.mail.gen', hash: '$2b$10$aaa' }])).toBe('a@w.mail.gen:$2b$10$aaa\nb@w.mail.gen:$2b$10$bbb\n');
        expect(renderSmtpAuthFile([])).toBe('');
        expect(MAIL_INBOX_CAPS).toEqual({ messages: 500, bytes: 200 * 1024 * 1024 });
    });
});

describe('the inbox book in the host', () => {
    it('create answers the inbox and its password ONCE; the file holds its bcrypt hash; then Mailpit restarts (finding 7)', async () => {
        const host = await open();
        const { inbox, password } = await host.create({ workspaceId: 'ws-a', workspaceSlug: 'example-a', name: 'signup' });
        expect(inbox).toEqual({ id: expect.stringMatching(/\S/), workspaceId: 'ws-a', name: 'signup', address: 'signup@example-a.mail.gen', smtpUser: 'signup@example-a.mail.gen', createdAt: 1_000 });
        expect(password).toMatch(/^\S{24,}$/);
        const line = (await authFile()).trim();
        expect(line.startsWith('signup@example-a.mail.gen:$2')).toBe(true);
        expect(await compare(password, line.slice(line.indexOf(':') + 1))).toBe(true);
        // The file first, THEN the restart: Mailpit reads it only at start.
        expect(events.slice(-2)).toEqual(['write:auth', 'restart']);
        expect(restarts).toHaveLength(1);
        // Answered once: the book never gives it back.
        expect(JSON.stringify(host.list())).not.toContain(password);
    });

    it('the store and the logs never hold a clear password (COUNTED: zero of three)', async () => {
        const logged: string[] = [];
        for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) vi.spyOn(console, level).mockImplementation((...a: unknown[]) => { logged.push(a.map(String).join(' ')); });
        const host = await open();
        const a = await host.create({ workspaceId: 'ws-a', workspaceSlug: 'example-a', name: 'signup' });
        const b = await host.create({ workspaceId: 'ws-b', workspaceSlug: 'example-b', name: 'signup' });
        const r = await host.rotate(a.inbox.id);
        const store = await readFile(join(dir, 'mail-inboxes.json'), 'utf8');
        const passwords = [a.password, b.password, r.password];
        expect(passwords.filter((p) => store.includes(p) || logged.some((l) => l.includes(p)) || (events.join('\n')).includes(p))).toEqual([]);
        // Positive control: the store does hold each inbox, by its address.
        expect(store).toContain('signup@example-a.mail.gen');
        expect(store).toContain('signup@example-b.mail.gen');
    });

    it('rotate: a new password; the old one no longer matches; Mailpit restarts again', async () => {
        const host = await open();
        const { inbox, password: old } = await host.create({ workspaceId: 'ws-a', workspaceSlug: 'example-a', name: 'signup' });
        const { inbox: same, password: next } = await host.rotate(inbox.id);
        expect(same.id).toBe(inbox.id);
        expect(next).not.toBe(old);
        const hash = (await authFile()).trim().split(':').slice(1).join(':');
        expect(await compare(next, hash)).toBe(true);
        expect(await compare(old, hash)).toBe(false);
        expect(restarts).toHaveLength(2);
    });

    it('delete: its line is gone, and Mailpit restarts; the other inboxes stay', async () => {
        const host = await open();
        const a = await host.create({ workspaceId: 'ws-a', workspaceSlug: 'example-a', name: 'signup' });
        await host.create({ workspaceId: 'ws-a', workspaceSlug: 'example-a', name: 'qa' });
        await host.remove(a.inbox.id);
        expect(await authFile()).not.toContain('signup@example-a.mail.gen');
        expect(await authFile()).toContain('qa@example-a.mail.gen');
        expect(host.list('ws-a').map((i) => i.name)).toEqual(['qa']);
        expect(restarts).toHaveLength(3);
    });

    it('list is per workspace; a name is unique within its workspace only; refusals write and restart nothing', async () => {
        const host = await open();
        await host.create({ workspaceId: 'ws-a', workspaceSlug: 'example-a', name: 'signup' });
        await host.create({ workspaceId: 'ws-b', workspaceSlug: 'example-b', name: 'signup' });
        expect(host.list('ws-a').map((i) => i.address)).toEqual(['signup@example-a.mail.gen']);
        expect(host.list().map((i) => i.address).sort()).toEqual(['signup@example-a.mail.gen', 'signup@example-b.mail.gen']);
        const before = restarts.length;
        await expect(host.create({ workspaceId: 'ws-a', workspaceSlug: 'example-a', name: 'signup' })).rejects.toThrow(/already has an inbox named signup/);
        await expect(host.create({ workspaceId: 'ws-a', workspaceSlug: 'example-a', name: 'Bad Name' })).rejects.toThrow(/inbox name/);
        await expect(host.rotate('nope')).rejects.toThrow(/no inbox nope/);
        await expect(host.remove('nope')).rejects.toThrow(/no inbox nope/);
        expect(restarts.length).toBe(before);
    });

    it('the book survives a restart of the host, and the auth file is rebuilt from it', async () => {
        const first = await open();
        const { password } = await first.create({ workspaceId: 'ws-a', workspaceSlug: 'example-a', name: 'signup' });
        await rm(join(dir, 'mailpit-auth'), { recursive: true, force: true });
        const again = await open();
        expect(again.list('ws-a').map((i) => i.address)).toEqual(['signup@example-a.mail.gen']);
        const line = (await authFile()).trim();
        expect(await compare(password, line.slice(line.indexOf(':') + 1))).toBe(true);
    });
});

describe('the shared Mailpit reads the book\'s auth file', () => {
    it('given the auth directory, the plan mounts it and points Mailpit at the file (control: without it, no auth file)', () => {
        const base = { engine: 'mailpit', major: '1.30', scope: { kind: 'shared' as const }, publishedPort: 1, surfacePorts: { ui: 2 }, credentials: { user: 'genie', password: 'p-123456789' } };
        const plan = containerPlan({ ...base, smtpAuthDir: '/home/genie/runtime/mailpit-auth' });
        expect(plan.mounts).toEqual([{ source: '/home/genie/runtime/mailpit-auth', target: '/genie-mail' }]);
        expect(plan.env).toMatchObject({ MP_SMTP_AUTH_FILE: `/genie-mail/${MAILPIT_SMTP_AUTH_FILE}`, MP_SMTP_AUTH_ALLOW_INSECURE: 'true' });
        const without = containerPlan(base);
        expect(without.env).not.toHaveProperty('MP_SMTP_AUTH_FILE');
        expect(without.mounts ?? []).toEqual([]);
    });
});
