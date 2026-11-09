import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ServiceInstance } from '../src/core/services.js';
import { composeServices } from './helpers/compose-alone.js';
import { type ComposedServices } from '../src/main/compose.js';
import { HostingReplica, type HostingDump } from '../src/main/hosting-host.js';
import { hostMachinePaths } from '../src/main/hosting-inputs.js';
import type { DockerRunner } from '../src/main/service-driver.js';
import type { PtyPort } from '../src/main/terminal-host.js';
import { HostingSurface } from '../src/renderer/components/FeatureSurfaces.js';
import { EMPTY_FEATURES, type FeatureData } from '../src/renderer/features.js';
import { hostingRig, tick, type HostingRig } from './helpers/hosting-rig.js';

/**
 * P5a.2 (the host split): what the window still decided about the host's hosting is the host's now.
 *  1. An engine update's "the dependents changed while the image was downloading" check runs IN THE HOST, at the moment it
 *     stops the engine, against the live dependents — the window is not involved.
 *  2. The inputs only Electron knows are explicit and checked: a host started without one SAYS so in Hosting, with the
 *     reason; and the window's environment (Check and repair) reaches the host live, with no restart.
 *  4. The front door's port and CA follow EVERY dump: a host that comes back on a new port reaches the window.
 *  6. The hosting dump carries each workspace's service variables: it travels on the LOCAL window link only.
 */

const rigs: HostingRig[] = [];
afterEach(async () => { for (const r of rigs.splice(0)) await r.close(); });
const rig = async (o: Parameters<typeof hostingRig>[0] = {}) => { const r = await hostingRig(o); rigs.push(r); return r; };

// ---- 1. the update's dependents check, in the host -------------------------------------------------------------------

const name = 'genie-svc-postgres-17';
const container = () => ({
    Id: 'original-id', Image: 'sha256:old', Name: `/${name}`,
    State: { Status: 'running', StartedAt: 'before' },
    Config: { Image: 'registry.example/team/postgres:17', Env: ['POSTGRES_USER=owner', 'POSTGRES_PASSWORD=kept-secret', 'POSTGRES_DB=existing'], Entrypoint: ['docker-entrypoint.sh'], Cmd: ['postgres'], Labels: {}, User: '', WorkingDir: '' },
    HostConfig: { RestartPolicy: { Name: 'unless-stopped', MaximumRetryCount: 0 }, NetworkMode: 'default', PortBindings: { '5432/tcp': [{ HostIp: '127.0.0.1', HostPort: '45123' }] }, Binds: ['legacy-volume:/var/lib/postgresql/data'] },
    Mounts: [{ Type: 'volume', Name: 'legacy-volume', Source: '/v', Destination: '/var/lib/postgresql/data', RW: true }],
});

function docker(onPull: () => void | Promise<void>) {
    const containers = new Map([[name, container()]]);
    const calls: string[][] = [];
    const run: DockerRunner = async (argv) => {
        const a = [...argv]; calls.push(a);
        if (a[0] === 'container' && a[1] === 'inspect') {
            const i = containers.get(a[2]!);
            return { exitCode: i ? 0 : 1, stdout: i ? JSON.stringify([i]) : 'No such container' };
        }
        if (a[0] === 'pull') { await onPull(); return { exitCode: 0, stdout: 'pulled' }; }
        if (a[0] === 'stop') containers.get(a[1]!)!.State.Status = 'exited';
        if (a[0] === 'rename') { const i = containers.get(a[1]!)!; containers.delete(a[1]!); containers.set(a[2]!, i); }
        if (a[0] === 'create') { const i = structuredClone(container()); i.Id = 'replacement-id'; i.State.Status = 'created'; containers.set(a[a.indexOf('--name') + 1]!, i); }
        if (a[0] === 'start') containers.get(a[1]!)!.State.Status = 'running';
        if (a[0] === 'rm') containers.delete(a.at(-1)!);
        return { exitCode: 0, stdout: '' };
    };
    return { run, calls };
}

const instance: ServiceInstance = { id: 'existing', engine: 'postgres', version: '17', scope: { kind: 'dedicated', workspaceId: 'ws' }, publishedPort: 45123, credentials: { user: 'owner', password: 'kept-secret', database: 'existing' }, active: true, containerName: name, volume: 'legacy-volume', image: container().Config.Image, adopted: 'v1' };

describe('1. an engine update’s dependents are checked in the host, when it stops the engine', () => {
    for (const changes of [true, false]) {
        it(changes ? 'a dependent that appears during the download: the host refuses, and nothing is replaced' : 'CONTROL: the same dependents at the stop: the host replaces the image', async () => {
            let r: HostingRig | null = null;
            const d = docker(() => {
                // While the image downloads, a new queue worker starts in the workspace — in the host, no window involved.
                if (changes) r!.supervisor.start({ id: 'worker', workspaceId: 'ws', name: 'New queue worker', command: 'worker', cwd: '/w', restart: 'never' });
            });
            r = await rig({ docker: d.run });
            await r.stack.engineReconcile;
            await r.stack.engines.adoptFromV1({ instances: [instance], record: { at: 'before', sawV1: true, sawDocker: true } });
            const w = await r.window();
            const preview = await w.replica.updateEngine(instance.id, { consent: false });
            expect(preview).toMatchObject({ kind: 'needs-consent' });
            await tick();
            const approved = w.replica.engineDependents(instance.id);
            expect(approved.join(' ')).toContain('workspace ws');
            const update = w.replica.updateEngine(instance.id, { consent: true, approvedDependents: approved });
            if (changes) {
                await expect(update).rejects.toThrow(/dependents changed/);
                expect(d.calls.filter((a) => ['rename', 'create'].includes(a[0]!))).toEqual([]);
            } else {
                await expect(update).resolves.toMatchObject({ kind: 'updated' });
                expect(d.calls.filter((a) => a[0] === 'create')).toHaveLength(1);
            }
        });
    }
});

// ---- 2. the launch inputs, and the window's env ------------------------------------------------------------------------

describe('2. the inputs only Electron knows are explicit and checked', () => {
    const exists = (present: readonly string[]) => (p: string) => present.includes(p);
    it('a host started with all three, each a real folder: no problem (CONTROL)', () => {
        const paths = hostMachinePaths({ GENIE_V1_USERDATA: '/v1', GENIE_APPDATA: '/app', GENIE_RESOURCES: '/res' }, '/home', exists(['/v1', '/app', '/res']));
        expect(paths.problems).toEqual([]);
        expect(paths.resources).toBe('/res');
    });

    it('one missing or not a folder: it is named, with what goes without it', () => {
        const paths = hostMachinePaths({ GENIE_V1_USERDATA: '/v1', GENIE_APPDATA: '/gone' }, '/home', exists(['/v1']));
        expect(paths.resources).toBeNull();
        expect(paths.appData).toBeNull();
        expect(paths.problems.join('\n')).toMatch(/GENIE_RESOURCES/);
        expect(paths.problems.join('\n')).toMatch(/Caddy/);
        expect(paths.problems.join('\n')).toMatch(/GENIE_APPDATA.*\/gone/);
        expect(paths.problems).toHaveLength(2);
    });

    it('a host without the bundled Caddy says WHY in Hosting, and its problems reach the window and the Hosting tab', async () => {
        const r = await rig({ hosting: { caddyBin: null, noCaddyReason: 'genie-host was started without the install’s resources folder (GENIE_RESOURCES)', problems: ['genie-host was started without Genie 1’s folder (GENIE_V1_USERDATA)'] } });
        expect(r.stack.externalFrontDoor).toMatchObject({ running: false, reason: expect.stringContaining('GENIE_RESOURCES') });
        const w = await r.window();
        expect(w.replica.externalFrontDoor).toEqual(r.stack.externalFrontDoor);
        expect(w.replica.hostingProblems()).toEqual(['genie-host was started without Genie 1’s folder (GENIE_V1_USERDATA)']);
        const html = renderToStaticMarkup(createElement(HostingSurface, {
            data: { ...EMPTY_FEATURES, hosting: { sites: [], processes: [], adding: null, frontDoor: w.replica.externalFrontDoor, problems: w.replica.hostingProblems() } } as FeatureData,
            onAction: () => {}, onNavigate: () => {},
        }));
        expect(html).toContain('data-hosting-problem');
        expect(html).toMatch(/GENIE_V1_USERDATA/);
        expect(html).toMatch(/GENIE_RESOURCES/);
    });

    it('the window’s environment reaches the host LIVE: pushed after a Check and repair, no restart', async () => {
        const adopted: Array<Readonly<Record<string, string>>> = [];
        const r = await rig({ server: { adoptWindowEnv: (env) => { adopted.push(env); } } });
        let env: Record<string, string> = { PHP_INI_SCAN_DIR: '/before' };
        const w = await r.window({ client: { env: () => env } });
        env = { PHP_INI_SCAN_DIR: '/repaired', PATH: '/genie/php' };
        await w.client.pushEnv();
        expect(adopted.at(-1)).toMatchObject({ PHP_INI_SCAN_DIR: '/repaired', PATH: '/genie/php' });
    });
});

// ---- 4. the front door's port and CA follow every dump -----------------------------------------------------------------

const PEM_A = '-----BEGIN CERTIFICATE-----\nA\n-----END CERTIFICATE-----\n';
const PEM_B = '-----BEGIN CERTIFICATE-----\nB\n-----END CERTIFICATE-----\n';
const dump = (port: number, caPem: string): HostingDump => ({
    frontDoorPort: port, browserTrust: { caPem, thumbprint: caPem === PEM_A ? 'AA' : 'BB' }, externalFrontDoor: { running: false, reason: 'the host’s' },
    routes: [], configuredHosts: [], deckItems: [], sites: [], specs: {}, declared: {}, engines: [], workspaces: {}, dependents: {}, reconcile: null, problems: [],
});

describe('4. the front door’s port and CA follow every dump, not only the first', () => {
    let dir: string | null = null;
    let services: ComposedServices | null = null;
    afterEach(async () => { await services?.shutdown(); services = null; if (dir) await rm(dir, { recursive: true, force: true }); dir = null; });

    it('a host that comes back on a new port, or with a new CA, reaches the composed window — and says so', async () => {
        const replica = new HostingReplica(async () => null);
        replica.rebase(dump(47111, PEM_A));
        dir = await mkdtemp(join(tmpdir(), 'genie-p5a2-port-'));
        const pty: PtyPort = { open: () => ({ id: 'p', pid: 1, shell: 'sh', scrollback: '' }), write: () => true, resize: () => true, kill: () => true, scrollback: () => '', onData: () => () => {}, onExit: () => () => {} };
        services = await composeServices({ userData: dir, pty, v1Settings: () => null, caddyBin: null, hosting: replica });
        expect(services.frontDoorPort).toBe(47111);
        let told = 0;
        services.onFrontDoorChange(() => { told += 1; });
        replica.rebase(dump(47222, PEM_A));
        expect(services.frontDoorPort).toBe(47222);
        expect(told).toBe(1);
        replica.rebase(dump(47222, PEM_B));
        expect(services.browserTrust()).toEqual({ caPem: PEM_B, thumbprint: 'BB' });
        expect(told).toBe(2);
    });
});

// ---- 6. the dump travels on the local window link only -----------------------------------------------------------------

describe('6. the hosting dump (each workspace’s service variables) travels on the LOCAL window link only', () => {
    it('a local window gets the dump and may drive the hosting (CONTROL)', async () => {
        const r = await rig();
        const w = await r.window({ local: true });
        expect(w.replica.frontDoorPort).toBe(r.stack.frontDoorPort);
        expect(w.replica.frontDoorPort).toBeGreaterThan(0);
        expect(await w.client.call('engine.hosting', ['engineStatuses', []])).toMatchObject({ ok: true });
    });

    it('any other connection gets no dump, no event, cannot call engine.hosting, and is never asked to elevate', async () => {
        const r = await rig();
        const w = await r.window({ local: false });
        expect(w.replica.frontDoorPort).toBe(0);
        expect(w.replica.engines.envFor('ws')).toEqual({});
        const call = await w.client.call('engine.hosting', ['engineStatuses', []]);
        expect(call).toMatchObject({ ok: false });
        expect(call.ok ? '' : call.reason).toMatch(/local/);
        // A site added in the host: the hosts block is due and needs a prompt — with only a non-local link, nobody is asked.
        await r.stack.envelopeSites.create({ name: 'shop', workspaceId: 'ws', repoPath: r.ws, serve: { mode: 'proxy' }, hostPort: 5174 });
        await tick();
        await r.stack.frontDoorSettled();
        await tick();
        expect(r.elevationsAsked).toEqual([]);
        expect(w.replica.sites.list()).toEqual([]);
    });
});
