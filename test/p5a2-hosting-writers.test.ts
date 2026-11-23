import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ServiceInstance } from '../src/core/services.js';
import { composeServices } from './helpers/compose-alone.js';
import { type ComposedServices } from '../src/main/compose.js';
import type { HostingApi } from '../src/main/hosting-host.js';
import { hostMachinePaths } from '../src/main/hosting-inputs.js';
import type { DockerRunner } from '../src/main/service-driver.js';
import type { PtyPort } from '../src/main/terminal-host.js';
import { HostingSurface } from '../src/renderer/components/FeatureSurfaces.js';
import { EMPTY_FEATURES, type FeatureData } from '../src/renderer/features.js';
import { hostingRig, tick, type HostingRig } from './helpers/hosting-rig.js';

/**
 * P5a.2 (the host split): what the window still decided about the host's hosting is the host's now. Since 2g-4d E2b (Tynn
 * #955) a window drives it over the protocol: genie-host's features (features.snapshot/act, the rig's `features()`).
 *  1. An engine update's "the dependents changed while the image was downloading" check runs IN THE HOST, at the moment it
 *     stops the engine, against the live dependents — the window's Services tab (features.act) only says what it approved.
 *  2. The inputs only Electron knows are explicit and checked: a host started without one SAYS so in Hosting, with the
 *     reason; and the window's environment (Check and repair) reaches the host live, with no restart.
 *  4. The front door's port and CA follow EVERY change of the hosting a composition is handed (genie-host's own front door
 *     reaches a window on frontdoor.watch: split-2g4d-d1-frontdoor-watch.test.ts).
 *  6. The hosting's elevations are asked of a LOCAL window only.
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
            const features = await r.features();
            // The Services tab's Update: a preview, with the dependents the person is shown.
            const previewed = await features.act({ kind: 'services.update', serviceId: instance.id, consent: false });
            expect(previewed.services?.updating).toMatchObject({ kind: 'needs-consent', serviceId: instance.id });
            await tick();
            const approved = previewed.services?.updating?.dependents ?? [];
            expect(approved.join(' ')).toContain('workspace ws');
            // The person's yes, with what they reviewed: the host checks the live dependents when it stops the engine.
            const update = features.act({ kind: 'services.update', serviceId: instance.id, consent: true, confirmed: true });
            if (changes) {
                await expect(update).rejects.toThrow(/dependents changed/);
                expect(d.calls.filter((a) => ['rename', 'create'].includes(a[0]!))).toEqual([]);
            } else {
                expect((await update).services?.updating ?? null).toBeNull();
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

    it('a host without the bundled Caddy says WHY in Hosting, and its problems reach the window’s features and the Hosting tab', async () => {
        const r = await rig({ hosting: { caddyBin: null, noCaddyReason: 'genie-host was started without the install’s resources folder (GENIE_RESOURCES)', problems: ['genie-host was started without Genie 1’s folder (GENIE_V1_USERDATA)'] } });
        expect(r.stack.externalFrontDoor).toMatchObject({ running: false, reason: expect.stringContaining('GENIE_RESOURCES') });
        const hosting = (await (await r.features()).snapshot()).hosting;
        expect(hosting?.frontDoor).toEqual(r.stack.externalFrontDoor);
        expect(hosting?.problems).toEqual(['genie-host was started without Genie 1’s folder (GENIE_V1_USERDATA)']);
        const html = renderToStaticMarkup(createElement(HostingSurface, {
            data: { ...EMPTY_FEATURES, hosting } as FeatureData,
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

// ---- 4. the front door's port and CA follow every change ---------------------------------------------------------------

const PEM_A = '-----BEGIN CERTIFICATE-----\nA\n-----END CERTIFICATE-----\n';
const PEM_B = '-----BEGIN CERTIFICATE-----\nB\n-----END CERTIFICATE-----\n';

describe('4. the front door’s port and CA follow every change of the hosting a composition is handed, not only the first', () => {
    let dir: string | null = null;
    let services: ComposedServices | null = null;
    afterEach(async () => { await services?.shutdown(); services = null; if (dir) await rm(dir, { recursive: true, force: true }); dir = null; });

    it('a hosting that comes back on a new port, or with a new CA, reaches the composition — and says so', async () => {
        const r = await rig();
        // genie-host's own stack, whose front door moves (a host restarted on a new port, a new CA): a HostingApi stand-in.
        let port = 47111;
        let trust: ReturnType<HostingApi['browserTrust']> = { caPem: PEM_A, thumbprint: 'AA' };
        const listeners = new Set<() => void>();
        const moved = () => { for (const l of [...listeners]) l(); };
        const hosting = new Proxy(r.stack, { get: (target, key) => key === 'frontDoorPort' ? port
            : key === 'browserTrust' ? () => trust
            : key === 'onFrontDoorChange' ? (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; }
            : Reflect.get(target, key, target) }) as HostingApi;
        dir = await mkdtemp(join(tmpdir(), 'genie-p5a2-port-'));
        const pty: PtyPort = { open: () => ({ id: 'p', pid: 1, shell: 'sh', scrollback: '' }), write: () => true, resize: () => true, kill: () => true, scrollback: () => '', onData: () => () => {}, onExit: () => () => {} };
        services = await composeServices({ userData: dir, pty, v1Settings: () => null, caddyBin: null, hosting });
        expect(services.frontDoorPort).toBe(47111);
        let told = 0;
        services.onFrontDoorChange(() => { told += 1; });
        port = 47222;
        moved();
        expect(services.frontDoorPort).toBe(47222);
        expect(told).toBe(1);
        trust = { caPem: PEM_B, thumbprint: 'BB' };
        moved();
        expect(services.browserTrust()).toEqual({ caPem: PEM_B, thumbprint: 'BB' });
        expect(told).toBe(2);
    });
});

// ---- 6. the hosting's elevations are asked of a local window only -----------------------------------------------------

describe('6. the hosting’s elevations are asked of a LOCAL window only', () => {
    const shopAdded = async (r: HostingRig) => {
        // A site added in the host: the hosts block is due and needs a prompt, which the person's Approve asks.
        await r.stack.envelopeSites.create({ name: 'shop', workspaceId: 'ws', repoPath: r.ws, serve: { mode: 'proxy' }, hostPort: 5174 });
        await tick();
        await r.stack.frontDoorSettled();
        await tick();
    };

    it('CONTROL: with a local window, the person’s Approve is asked of it, and the hosts file is written', async () => {
        const r = await rig();
        await r.window({ local: true });
        await shopAdded(r);
        expect(r.elevationsAsked).toEqual([]);
        expect(await r.stack.syncHosts()).toEqual({ changed: true, elevated: true });
        expect(r.elevationsAsked).toHaveLength(1);
    });

    it('with only another connection, nobody is asked: the Approve waits for a local window', async () => {
        const r = await rig();
        await r.window({ local: false });
        await shopAdded(r);
        const held = await r.stack.syncHosts();
        expect('error' in held ? held.error : '').toMatch(/^waiting for a window/);
        expect(r.elevationsAsked).toEqual([]);
    });
});
