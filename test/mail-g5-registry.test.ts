import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ServiceInstance } from '../src/core/services.js';
import { runtimeDir } from '../src/main/paths.js';
import { ServiceDriver, type DockerRunner } from '../src/main/service-driver.js';
import { ServiceRegistry } from '../src/main/service-registry.js';

/**
 * GENIE MAIL G5 IN THE REGISTRY (Tynn story #491): the shared Mailpit and the inbox book meet here.
 *   - a workspace's env from the shared Mailpit carries its default inbox's credentials (`mail.credentialsFor`);
 *   - a NEW shared Mailpit is created reading the book (its auth directory mounted, MP_SMTP_AUTH_FILE set);
 *   - the one already running from before G5 is wired to the book by `wireMail`: recreated with the mount, keeping its
 *     name, ports, credentials, data volume and every workspace's slice; asked again, nothing is done.
 */
function fakeDocker() {
    const calls: (readonly string[])[] = [];
    const containers = new Map<string, 'created' | 'running' | 'exited'>([['genie-shared-mailpit-1.30', 'running']]);
    const run: DockerRunner = async (args) => {
        calls.push(args);
        const [cmd, sub] = args;
        if (cmd === 'image' && sub === 'inspect') return { stdout: '[{}]', exitCode: 0 };
        if (cmd === 'container' && sub === 'inspect') {
            const st = containers.get(args[2]!);
            return st ? { stdout: JSON.stringify([{ State: { Status: st, StartedAt: 't' } }]), exitCode: 0 } : { stdout: '', exitCode: 1 };
        }
        if (cmd === 'create') { containers.set(args[2]!, 'created'); return { stdout: '', exitCode: 0 }; }
        if (cmd === 'start') { containers.set(args[1]!, 'running'); return { stdout: '', exitCode: 0 }; }
        if (cmd === 'stop') { containers.set(args[1]!, 'exited'); return { stdout: '', exitCode: 0 }; }
        if (cmd === 'rm') { containers.delete(args[args.length - 1]!); return { stdout: '', exitCode: 0 }; }
        return { stdout: '', exitCode: 0 };
    };
    return { run, calls, containers };
}

const AUTH = '/genie/runtime/mailpit-auth';
const creds = (ws: string) => ({ username: `app@${ws}.mail.gen`, password: `pw-${ws}-123456789`, from: `app@${ws}.mail.gen` });
let dir: string;
let docker: ReturnType<typeof fakeDocker>;
let registry: ServiceRegistry;
let port: number;

const preG5: ServiceInstance = {
    id: 'svc_shared_mailpit', engine: 'mailpit', version: '1.30', scope: { kind: 'shared' }, publishedPort: 4101, credentials: { user: 'genie', password: 'SendApi-0001' }, active: true,
    slices: { 'ws-a': { identifier: 'ws_ws_a', password: 'x', active: true }, 'ws-b': { identifier: 'ws_ws_b', password: 'y', active: true } }, publishedPorts: { ui: 4102 },
};

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'genie2-mail-g5-registry-'));
    docker = fakeDocker();
    port = 5000;
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

const open = async (instances: ServiceInstance[] = []) => {
    await mkdir(runtimeDir(dir), { recursive: true });
    await writeFile(join(runtimeDir(dir), 'services.json'), JSON.stringify({ instances }), 'utf8');
    registry = await ServiceRegistry.open(dir, new ServiceDriver(docker.run), {
        allocatePort: () => ++port, randomPassword: () => 'GenPw-000000001', sleep: async () => {}, now: () => 0,
        mail: { authDir: AUTH, credentialsFor: (ws) => (ws === 'ws-a' ? creds('ws-a') : null) },
    });
};
const createArgs = () => docker.calls.filter((c) => c[0] === 'create').at(-1) ?? [];
const flagValues = (args: readonly string[], flag: string) => args.flatMap((a, i) => (args[i - 1] === flag ? [a] : []));

describe('the registry and the book', () => {
    it('a workspace on the shared Mailpit gets its default inbox\'s credentials; one with none yet gets the address alone', async () => {
        await open([preG5]);
        expect(registry.envFor('ws-a')).toMatchObject({ MAIL_USERNAME: 'app@ws-a.mail.gen', MAIL_PASSWORD: 'pw-ws-a-123456789', MAIL_FROM_ADDRESS: 'app@ws-a.mail.gen' });
        expect(registry.envFor('ws-b')).toEqual({ MAIL_MAILER: 'smtp', MAIL_HOST: 'mail.gen', MAIL_PORT: '4101' });
    });

    it('a NEW shared Mailpit is created reading the book', async () => {
        await open([]);
        await registry.add({ engine: 'mailpit', major: '1.30', scope: { kind: 'shared' }, consent: true, workspaceId: 'ws-a' });
        const args = createArgs();
        expect(flagValues(args, '--mount')).toContain(`type=bind,source=${AUTH},target=/genie-mail,readonly`);
        expect(flagValues(args, '-e')).toEqual(expect.arrayContaining(['MP_SMTP_AUTH_FILE=/genie-mail/smtp-auth', 'MP_SMTP_AUTH_ALLOW_INSECURE=true']));
        expect(registry.list().find((i) => i.engine === 'mailpit')!.mailAuth).toBe(true);
    });

    it('the running pre-G5 Mailpit is wired by wireMail: recreated with the mount, keeping its name, ports, credentials, volume and slices', async () => {
        await open([preG5]);
        expect(registry.mailWired()).toBe(false);
        expect(await registry.wireMail()).toBe(true);
        const args = createArgs();
        expect(args[2]).toBe('genie-shared-mailpit-1.30');
        expect(flagValues(args, '-p')).toEqual(['127.0.0.1:4101:1025', '127.0.0.1:4102:8025']);
        expect(flagValues(args, '-v')).toEqual(['genie-shared-mailpit-1.30-data:/data']);
        expect(flagValues(args, '--mount')).toEqual([`type=bind,source=${AUTH},target=/genie-mail,readonly`]);
        expect(flagValues(args, '-e')).toContain('MP_SEND_API_AUTH=genie:SendApi-0001');
        // Its data volume is never removed, and it is running again.
        expect(docker.calls.filter((c) => c[0] === 'volume' && c[1] === 'rm')).toEqual([]);
        expect(docker.containers.get('genie-shared-mailpit-1.30')).toBe('running');
        const after = registry.list().find((i) => i.id === 'svc_shared_mailpit')!;
        expect(after).toMatchObject({ mailAuth: true, publishedPort: 4101, credentials: preG5.credentials, slices: preG5.slices });
        expect(registry.mailWired()).toBe(true);
        // Asked again: nothing is done.
        const n = docker.calls.length;
        expect(await registry.wireMail()).toBe(false);
        expect(docker.calls.length).toBe(n);
    });

    it('restartMail restarts the shared Mailpit so it reads the book again (G1\'s finding 7)', async () => {
        await open([{ ...preG5, mailAuth: true }]);
        await registry.restartMail();
        expect(docker.calls.filter((c) => c[0] === 'stop' || c[0] === 'start').map((c) => c.slice(0, 2))).toEqual([['stop', 'genie-shared-mailpit-1.30'], ['start', 'genie-shared-mailpit-1.30']]);
    });
});
