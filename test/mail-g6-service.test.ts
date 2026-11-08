import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ServiceInstance } from '../src/core/services.js';
import { MailService, type MailServicePorts } from '../src/main/mail-service.js';
import { mailToolPort } from '../src/main/mcp-tools-mail.js';
import { runtimeDir } from '../src/main/paths.js';
import { ServiceDriver, type DockerRunner } from '../src/main/service-driver.js';
import { ServiceRegistry } from '../src/main/service-registry.js';

/**
 * GENIE MAIL G6 IN THE HOST (Tynn story #492): what the `mail` tool's create, rotate and delete do to the inbox book and
 * the live Mailpit. Mailpit reads its auth file only at start (G1's finding 7), so each change is followed by a restart;
 * the workspace's DEFAULT inbox is its sites' and processes' identity (G5), so rotating it goes the G5 way: the keychain,
 * the env, the running processes, and only then Mailpit. Another workspace's inbox is refused by name, with nothing done.
 */
let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'genie2-mail-g6-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe('the mail service does what the tool asks, in the caller\'s workspace only', () => {
    let events: string[];
    let secrets: Map<string, string>;
    let attached: string[];
    let passwords: number;
    const ports = (): MailServicePorts => ({
        storeFile: join(dir, 'mail-inboxes.json'),
        authDir: join(dir, 'mailpit-auth'),
        hash: async (p) => `hash(${p})`,
        randomPassword: () => `Password-${++passwords}`,
        secrets: { get: async (n) => secrets.get(n) ?? null, set: async (n, v) => { secrets.set(n, v); events.push(`keychain:${n.startsWith('mail/inbox/') ? 'set' : n}`); return true; } },
        attachedWorkspaces: () => attached,
        wired: () => true,
        wire: async () => { events.push('wire'); },
        restart: async () => { events.push('restart'); },
        envChanged: (ids) => { events.push(`env:${[...ids].join(',')}`); },
        restartProcesses: async (ids) => { events.push(`processes:${[...ids].join(',')}`); return { ok: true }; },
    });
    beforeEach(() => { events = []; secrets = new Map(); attached = ['ws-a', 'ws-b']; passwords = 0; });

    const opened = async () => {
        const service = await MailService.open(ports());
        await service.sync();
        events = [];
        return service;
    };
    const authFile = () => readFile(join(dir, 'mailpit-auth', 'smtp-auth'), 'utf8');

    it('createInbox: in the book and the auth file, then Mailpit restarted to read it; the password answered once', async () => {
        const service = await opened();
        const made = await service.createInbox('ws-a', 'signup');
        expect(made.inbox).toMatchObject({ workspaceId: 'ws-a', name: 'signup', address: 'signup@ws-a.mail.gen', smtpUser: 'signup@ws-a.mail.gen' });
        expect(made.password).toBe('Password-3');
        expect(await authFile()).toContain(`signup@ws-a.mail.gen:hash(Password-3)`);
        expect(events).toEqual(['restart']);
        expect(service.inboxes('ws-a').map((i) => i.name)).toEqual(['app', 'signup']);
        expect(service.inboxes('ws-b').map((i) => i.name)).toEqual(['app']);
    });

    it('a workspace with no shared Mailpit is refused, with nothing written', async () => {
        const service = await opened();
        attached = ['ws-a'];
        await expect(service.createInbox('ws-c', 'signup')).rejects.toThrow(/no Genie Mail[\s\S]*services add/);
        expect(service.inboxes('ws-c')).toEqual([]);
        expect(events).toEqual([]);
    });

    it('rotating another workspace\'s inbox, or removing it, is refused by name with nothing changed', async () => {
        const service = await opened();
        const b = service.inboxes('ws-b')[0]!;
        const before = await authFile();
        await expect(service.rotateInbox('ws-a', b.id)).rejects.toThrow(new RegExp(`${b.id} is not one of this workspace.s inboxes`));
        await expect(service.removeInbox('ws-a', b.id)).rejects.toThrow(new RegExp(`${b.id} is not one of this workspace.s inboxes`));
        expect(await authFile()).toBe(before);
        expect(events).toEqual([]);
    });

    it('rotateInbox (not the default): the new hash in the file, Mailpit restarted; the env untouched', async () => {
        const service = await opened();
        const made = await service.createInbox('ws-a', 'signup');
        events = [];
        const rotated = await service.rotateInbox('ws-a', made.inbox.id);
        expect(rotated.password).toBe('Password-4');
        expect(await authFile()).toContain(`signup@ws-a.mail.gen:hash(Password-4)`);
        expect(events).toEqual(['restart']);
    });

    it('rotating the DEFAULT inbox: kept in the keychain, the env and its running processes told, and only then Mailpit', async () => {
        const service = await opened();
        const app = service.inboxes('ws-a').find((i) => i.name === 'app')!;
        const rotated = await service.rotateInbox('ws-a', app.id);
        expect(secrets.get(`mail/inbox/${app.id}`)).toBe(rotated.password);
        expect(service.credentialsFor('ws-a')).toMatchObject({ username: 'app@ws-a.mail.gen', password: rotated.password });
        expect(events).toEqual(['keychain:set', 'env:ws-a', 'processes:ws-a', 'restart']);
    });

    it('removeInbox: gone from the book and the file, Mailpit restarted; the default inbox is never removed', async () => {
        const service = await opened();
        const made = await service.createInbox('ws-a', 'signup');
        events = [];
        await service.removeInbox('ws-a', made.inbox.id);
        expect(service.inboxes('ws-a').map((i) => i.name)).toEqual(['app']);
        expect(await authFile()).not.toContain('signup@ws-a.mail.gen');
        expect(events).toEqual(['restart']);
        const app = service.inboxes('ws-a')[0]!;
        await expect(service.removeInbox('ws-a', app.id)).rejects.toThrow(/default inbox/);
        expect(service.inboxes('ws-a')).toHaveLength(1);
    });
});

describe('the registry gives the tool the shared Mailpit\'s API, on loopback', () => {
    const run: DockerRunner = async (args) => (args[0] === 'container' && args[1] === 'inspect' ? { stdout: JSON.stringify([{ State: { Status: 'running', StartedAt: 't' } }]), exitCode: 0 } : { stdout: '[{}]', exitCode: 0 });
    const shared: ServiceInstance = {
        id: 'svc_shared_mailpit', engine: 'mailpit', version: '1.30', scope: { kind: 'shared' }, publishedPort: 4101, credentials: { user: 'genie', password: 'SendApi-0001' }, active: true,
        slices: { 'ws-a': { identifier: 'ws_ws_a', password: 'x', active: true } }, publishedPorts: { ui: 4102 }, mailAuth: true,
    };
    const open = async (instances: ServiceInstance[]) => {
        await mkdir(runtimeDir(dir), { recursive: true });
        await writeFile(join(runtimeDir(dir), 'services.json'), JSON.stringify({ instances }), 'utf8');
        return ServiceRegistry.open(dir, new ServiceDriver(run), { allocatePort: () => 5000, randomPassword: () => 'GenPw-000000001', sleep: async () => {}, now: () => 0 });
    };

    it('mailApiUrl: the shared Mailpit\'s API on loopback; none when there is no shared Mailpit', async () => {
        expect((await open([shared])).mailApiUrl()).toBe('http://127.0.0.1:4102');
        expect((await open([])).mailApiUrl()).toBeNull();
        // A Mailpit taken over from Genie 1 is another source (decision 2): not Genie Mail's.
        expect((await open([{ ...shared, adopted: 'v1' }])).mailApiUrl()).toBeNull();
    });
});

describe('the tool\'s port, composed as the host composes it', () => {
    it('SMTP host and port are the ones the workspace\'s env carries; the reader is the shared Mailpit\'s', async () => {
        const service = await MailService.open({
            storeFile: join(dir, 'mail-inboxes.json'), authDir: join(dir, 'mailpit-auth'), hash: async (p) => `h(${p})`,
            secrets: { get: async () => null, set: async () => true }, attachedWorkspaces: () => ['ws-a'], wired: () => true,
            wire: async () => {}, restart: async () => {}, envChanged: () => {},
        });
        const port = mailToolPort({
            service,
            envFor: (ws) => (ws === 'ws-a' ? { MAIL_MAILER: 'smtp', MAIL_HOST: 'mail.gen', MAIL_PORT: '4101' } : {}),
            apiUrl: () => 'http://127.0.0.1:4102',
        });
        expect(port.smtp('ws-a')).toEqual({ host: 'mail.gen', port: 4101 });
        expect(port.smtp('ws-b')).toBeNull();
        expect(port.reader()?.source).toEqual({ id: 'shared', sendApiClosed: true });
        const none = mailToolPort({ service, envFor: () => ({}), apiUrl: () => null });
        expect(none.reader()).toBeNull();
    });
});
