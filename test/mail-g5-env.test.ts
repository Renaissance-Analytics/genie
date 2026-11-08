import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_INBOX } from '../src/core/mail.js';
import { serviceEnvFor, type ServiceInstance } from '../src/core/services.js';
import { bcryptHash } from '../src/main/mail-bcrypt.js';
import { MailService, mailSlugOf, type MailServicePorts } from '../src/main/mail-service.js';

/**
 * GENIE MAIL G5 (Tynn story #491, spec .ai/plans/specs/genie-mail.md): A WORKSPACE'S SITES AND PROCESSES SEND AS ITS
 * DEFAULT INBOX. Their env carries MAIL_USERNAME / MAIL_PASSWORD that authenticate and MAIL_FROM_ADDRESS at
 * `<workspace>.mail.gen`; the default inbox is made on first use and reused after; Genie 1's `genie+<tag>@mail.gen`
 * (mailTagEnv) is retired.
 *
 * AND THE ORDER THAT KEEPS EVERY APP SENDING (the owner's ruling, 2026-11-08; G3's measurement): an empty book makes
 * Mailpit require no auth, and its first inbox makes every unauthenticated sender get `530`. So the live shared Mailpit
 * reads the book only once EVERY workspace using it has its credentials in its env, and its running sites have been
 * told: credentials first, the env-change next, Mailpit reading the book last. A workspace attaching later gets its
 * credentials before Mailpit restarts with its inbox. The password is held in the host keychain for env injection only.
 */
const addr = (slug: string) => `${DEFAULT_INBOX}@${slug}.mail.gen`;

describe('the env a workspace gets from the shared Mailpit', () => {
    const shared: ServiceInstance = {
        id: 'svc_mail', engine: 'mailpit', version: '1.30', scope: { kind: 'shared' }, publishedPort: 4101, credentials: { user: 'genie', password: 'send-api' }, active: true,
        slices: { 'ws-a': { identifier: 'ws_example_a', password: 'slice-pw', active: true } }, publishedPorts: { ui: 4102 },
    };

    it('with the workspace\'s default inbox: MAIL_USERNAME / MAIL_PASSWORD and MAIL_FROM_ADDRESS at <workspace>.mail.gen; no tag', () => {
        const env = serviceEnvFor([shared], 'ws-a', { namespace: 'ws_example_a', mail: { username: addr('example-a'), password: 'InboxPw-1', from: addr('example-a') } });
        expect(env).toEqual({ MAIL_MAILER: 'smtp', MAIL_HOST: 'mail.gen', MAIL_PORT: '4101', MAIL_USERNAME: addr('example-a'), MAIL_PASSWORD: 'InboxPw-1', MAIL_FROM_ADDRESS: addr('example-a') });
    });

    it('without an inbox yet: the SMTP address only, and Genie 1\'s tag is retired (no genie+ address, no GENIE_MAIL_TAG)', () => {
        const env = serviceEnvFor([shared], 'ws-a', { namespace: 'ws_example_a' });
        expect(env).toEqual({ MAIL_MAILER: 'smtp', MAIL_HOST: 'mail.gen', MAIL_PORT: '4101' });
        expect(JSON.stringify(env)).not.toMatch(/genie\+|GENIE_MAIL_TAG/);
    });

    it('a Mailpit taken over from Genie 1 has no book: it is never given the shared one\'s inbox credentials', () => {
        const v1: ServiceInstance = { ...shared, id: 'svc_v1_mailpit', adopted: 'v1', containerName: 'genie-svc-mailpit-1.30' };
        const env = serviceEnvFor([v1], 'ws-a', { namespace: 'ws_example_a', mail: { username: addr('example-a'), password: 'InboxPw-1', from: addr('example-a') } });
        expect(env).not.toHaveProperty('MAIL_PASSWORD');
        expect(env).not.toHaveProperty('GENIE_MAIL_TAG');
    });
});

describe('the default inbox, and the order that keeps every app sending', () => {
    let dir: string;
    let events: string[];
    let secrets: Map<string, string>;
    let attached: string[];
    let wired: boolean;
    let envAtWire: Record<string, unknown> | null;
    let service: MailService;

    const ports = (over: Partial<MailServicePorts> = {}): MailServicePorts => ({
        storeFile: join(dir, 'mail-inboxes.json'),
        authDir: join(dir, 'mailpit-auth'),
        hash: bcryptHash,
        now: () => 5,
        secrets: {
            get: async (name) => secrets.get(name) ?? null,
            set: async (name, value) => { secrets.set(name, value); events.push(`secret:${name.split('/')[0]}`); return true; },
        },
        attachedWorkspaces: () => attached,
        wired: () => wired,
        wire: async () => {
            envAtWire = Object.fromEntries(attached.map((ws) => [ws, service.credentialsFor(ws)]));
            wired = true;
            events.push('wire');
        },
        restart: async () => { events.push('restart'); },
        envChanged: (workspaceIds) => { events.push(`env:${[...workspaceIds].sort().join(',')}`); },
        ...over,
    });

    beforeEach(async () => {
        dir = await mkdtemp(join(tmpdir(), 'genie2-mail-g5-'));
        events = [];
        secrets = new Map();
        attached = ['ws-a', 'ws-b'];
        wired = false;
        envAtWire = null;
    });
    afterEach(async () => {
        vi.restoreAllMocks();
        await rm(dir, { recursive: true, force: true });
    });

    it('first use: each workspace on the shared Mailpit gets its default inbox; credentials, then the env-change, then Mailpit reads the book', async () => {
        service = await MailService.open(ports());
        await service.sync();
        for (const ws of ['ws-a', 'ws-b']) {
            expect(service.credentialsFor(ws)).toEqual({ username: addr(mailSlugOf(ws)), password: expect.stringMatching(/^\S{24,}$/), from: addr(mailSlugOf(ws)) });
        }
        // THE ORDER: both secrets kept, both workspaces' env changed, and only then is the live Mailpit wired to the book.
        expect(events).toEqual(['secret:mail', 'secret:mail', 'env:ws-a,ws-b', 'wire']);
        // At the moment Mailpit was pointed at the book, every workspace using it already had its credentials.
        expect(envAtWire).toEqual({ 'ws-a': expect.objectContaining({ password: expect.any(String) }), 'ws-b': expect.objectContaining({ password: expect.any(String) }) });
    });

    it('reused after: a second sync makes no inbox, changes no env, and neither wires nor restarts anything', async () => {
        service = await MailService.open(ports());
        await service.sync();
        const first = service.credentialsFor('ws-a');
        events = [];
        await service.sync();
        expect(events).toEqual([]);
        expect(service.credentialsFor('ws-a')).toEqual(first);
        // And across a host restart: the book and the keychain give the same credentials back, nothing made again.
        const again = await MailService.open(ports());
        await again.sync();
        expect(again.credentialsFor('ws-a')).toEqual(first);
        expect(events).toEqual([]);
    });

    it('a workspace attaching later gets its credentials and its sites are told BEFORE Mailpit restarts with its inbox', async () => {
        service = await MailService.open(ports());
        await service.sync();
        events = [];
        attached = ['ws-a', 'ws-b', 'ws-c'];
        await service.sync();
        expect(events).toEqual(['secret:mail', 'env:ws-c', 'restart']);
        expect(service.credentialsFor('ws-c')?.from).toBe(addr(mailSlugOf('ws-c')));
    });

    it('a password the keychain lost is not guessed: the inbox is rotated, the env told, then Mailpit restarted', async () => {
        service = await MailService.open(ports());
        await service.sync();
        const lost = service.credentialsFor('ws-a')!;
        secrets.clear();
        events = [];
        const reopened = await MailService.open(ports());
        await reopened.sync();
        const restored = reopened.credentialsFor('ws-a')!;
        expect(restored.username).toBe(lost.username);
        expect(restored.password).not.toBe(lost.password);
        expect(events.slice(-2)).toEqual(['env:ws-a,ws-b', 'restart']);
    });

    it('the password is in the keychain and the env only: never in the book or a log', async () => {
        const logged: string[] = [];
        for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) vi.spyOn(console, level).mockImplementation((...a: unknown[]) => { logged.push(a.map(String).join(' ')); });
        service = await MailService.open(ports());
        await service.sync();
        const store = await readFile(join(dir, 'mail-inboxes.json'), 'utf8');
        const passwords = ['ws-a', 'ws-b'].map((ws) => service.credentialsFor(ws)!.password);
        expect(passwords.filter((p) => store.includes(p) || logged.some((l) => l.includes(p)))).toEqual([]);
        // Positive control: the keychain holds them.
        expect([...secrets.values()].sort()).toEqual([...passwords].sort());
    });

    it('nothing to do with no workspace on the shared Mailpit: no inbox, and the live Mailpit is not wired to an empty book', async () => {
        attached = [];
        service = await MailService.open(ports());
        await service.sync();
        expect(events).toEqual([]);
        expect(wired).toBe(false);
    });
});
