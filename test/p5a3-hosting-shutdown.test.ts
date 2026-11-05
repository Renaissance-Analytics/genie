import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ServiceInstance } from '../src/core/services.js';
import { composeServices, type ComposedServices } from '../src/main/compose.js';
import { shutDownHosted } from '../src/main/host-shutdown.js';
import type { HostingApi } from '../src/main/hosting-host.js';
import type { ProcessSpec, ProcessStatus, SupervisorApi } from '../src/main/process-supervisor.js';
import type { DockerRunner } from '../src/main/service-driver.js';
import type { PtyPort } from '../src/main/terminal-host.js';
import { hostingRig, tick, type HostingRig } from './helpers/hosting-rig.js';

/**
 * P5a.3 (the host split): WHAT A QUIT STOPS, NOW THAT THE HOSTING IS GENIE-HOST'S.
 *  (a) "Shut down everything" ends the host: it stops every supervised process it owns — the sites, the front door's
 *      Caddy, the kept workers — THEN the hosting's own shutdown, then its children end. In that order.
 *  (b) It never stops or removes an engine's container: databases and Redis outlive a quit (`--restart unless-stopped`)
 *      and are reconciled at the next boot. CONTROL: the person's Stop of an engine does stop its container.
 *  (c) A linked window's quit stops nothing of the hosting it does not own: compose handed the host's hosting and
 *      supervisor calls none of their stops or closes. CONTROL (e): the emergency path (no host) still stops its own.
 *  (d) A new host ADOPTS the running containers: its boot reconcile finds them running and starts nothing for them.
 */

const rigs: HostingRig[] = [];
afterEach(async () => { for (const r of rigs.splice(0)) await r.close(); });

/** Docker as the CLI answers it, with the engines' containers RUNNING: every call counted. */
function dockerWith(running: readonly string[]) {
    const calls: string[][] = [];
    const containers = new Map<string, 'running' | 'exited'>(running.map((n) => [n, 'running']));
    const run: DockerRunner = async (args) => {
        const a = [...args];
        calls.push(a);
        if (a[0] === 'version') return { stdout: '28.1.0', exitCode: 0 };
        if (a[0] === 'container' && a[1] === 'inspect') {
            const st = containers.get(a[2]!);
            return st ? { stdout: JSON.stringify([{ State: { Status: st, StartedAt: 't' } }]), exitCode: 0 } : { stdout: '', exitCode: 1 };
        }
        if (a[0] === 'start') { containers.set(a[1]!, 'running'); return { stdout: '', exitCode: 0 }; }
        if (a[0] === 'stop') { containers.set(a[1]!, 'exited'); return { stdout: '', exitCode: 0 }; }
        return { stdout: '', exitCode: 0 };
    };
    return { run, calls, containers, touched: () => calls.filter((c) => ['stop', 'rm', 'kill', 'start', 'run', 'create'].includes(c[0]!)) };
}

const PG = 'genie-ws-postgres-17';
const pg: ServiceInstance = { id: 'svc_pg', engine: 'postgres', version: '17', scope: { kind: 'dedicated', workspaceId: 'ws' }, publishedPort: 45123, credentials: { user: 'u', password: 'kept-secret', database: 'd' }, active: true, containerName: PG, volume: 'pg-data', image: 'postgres:17', adopted: 'v1' };

async function hostWithEngine() {
    const docker = dockerWith([PG]);
    const r = await hostingRig({ docker: docker.run, hosting: { engineAnswers: async () => true } });
    rigs.push(r);
    await r.stack.engineReconcile;
    await r.stack.engines.adoptFromV1({ instances: [pg], record: { at: 'before', sawV1: true, sawDocker: true } });
    return { r, docker };
}

describe('(a)+(b) the host’s shutdown', () => {
    it('stops every supervised process it owns, THEN the hosting’s own shutdown, then its children end — in that order', async () => {
        const order: string[] = [];
        const statuses: ProcessStatus[] = ['site:shop', 'genie-front-door', 'proc:queue'].map((id) => ({ id, workspaceId: 'ws', name: id, state: 'running', pid: 1, exitCode: null, restarts: 0, since: 0, reason: null }) as unknown as ProcessStatus);
        const supervisor = { list: () => statuses, stop: (id: string) => { order.push(`stop ${id}`); return true; } } as unknown as SupervisorApi;
        const hosting = { quiesce: () => { order.push('quiesce'); }, shutdown: async () => { order.push('hosting shutdown'); } };
        // The host's clocks first (decision 2): no scheduled task or flow starts a process after the stops.
        const schedulers = [{ stop: () => { order.push('process scheduler stop'); } }, { stop: () => { order.push('flows engine stop'); } }];
        await shutDownHosted({ supervisor, hosting, endChildren: async () => { order.push('children end'); }, schedulers });
        expect(order).toEqual(['process scheduler stop', 'flows engine stop', 'quiesce', 'stop site:shop', 'stop genie-front-door', 'stop proc:queue', 'hosting shutdown', 'children end']);
    });

    it('stops the sites and the front door under the REAL stack — and never stops or removes an engine’s container', async () => {
        const { r, docker } = await hostWithEngine();
        await r.stack.envelopeSites.create({ name: 'shop', workspaceId: 'ws', repoPath: r.ws, serve: { mode: 'proxy' }, devServer: { stack: 'node', command: 'node shop.mjs {port}' } });
        await tick();
        const running = r.supervisor.list().filter((p) => p.state === 'running').map((p) => p.id);
        expect(running).toEqual(expect.arrayContaining(['genie-front-door']));
        expect(running.length).toBeGreaterThan(1);
        const mark = docker.calls.length;
        await shutDownHosted({ supervisor: r.supervisor, hosting: r.stack, endChildren: async () => {} });
        expect(r.supervisor.list().filter((p) => p.state === 'running')).toEqual([]);
        expect(docker.calls.slice(mark).filter((c) => ['stop', 'rm', 'kill'].includes(c[0]!))).toEqual([]);
        expect(docker.containers.get(PG)).toBe('running');
    });

    it('CONTROL: the person’s Stop of the same engine does stop its container (the fake can see one)', async () => {
        const { r, docker } = await hostWithEngine();
        const mark = docker.calls.length;
        await r.stack.stopEngine(pg.id);
        expect(docker.calls.slice(mark).filter((c) => c[0] === 'stop').map((c) => c.join(' '))).toEqual([`stop ${PG}`]);
        expect(docker.containers.get(PG)).toBe('exited');
    });
});

describe('(d) a new host adopts the running containers', () => {
    it('its boot reconcile finds the engine running and starts nothing for it', async () => {
        const first = await hostWithEngine();
        await shutDownHosted({ supervisor: first.r.supervisor, hosting: first.r.stack, endChildren: async () => {} });
        // The next host, on the same home and the same Docker: the container never stopped.
        const docker = first.docker;
        const mark = docker.calls.length;
        const next = await hostingRig({ home: first.r.home, docker: docker.run, hosting: { engineAnswers: async () => true } });
        rigs.push(next);
        const report = await next.stack.engineReconcile;
        expect(report.engines.map((e) => [e.id, e.outcome])).toEqual([[pg.id, 'running']]);
        expect(docker.calls.slice(mark).filter((c) => ['start', 'run', 'create', 'stop', 'rm'].includes(c[0]!))).toEqual([]);
    });
});

describe('(c)+(e) the window’s quit', () => {
    let dir: string | null = null;
    let services: ComposedServices | null = null;
    afterEach(async () => { await services?.shutdown(); services = null; if (dir) await rm(dir, { recursive: true, force: true }); dir = null; });
    const pty = (): PtyPort => ({ open: () => ({ id: 'p', pid: 1, shell: 'sh', scrollback: '' }), write: () => true, resize: () => true, kill: () => true, scrollback: () => '', onData: () => () => {}, onExit: () => () => {} });

    function hostSupervisor() {
        const stops: string[] = [];
        const listed: ProcessStatus[] = [{ id: 'site:shop', workspaceId: 'ws', name: 'shop', state: 'running', pid: 1, exitCode: null, restarts: 0, since: 0, reason: null } as unknown as ProcessStatus];
        const supervisor = {
            list: () => listed, status: (id: string) => listed.find((p) => p.id === id) ?? null, stop: (id: string) => { stops.push(id); return true; },
            start: (spec: ProcessSpec) => ({ ...listed[0]!, id: spec.id }), restart: () => null, forget: () => false, command: () => undefined, log: () => undefined, readLog: () => null,
            recheck: () => [], watchLiveness: () => () => {}, onChange: () => () => {}, onOutput: () => () => {},
        } as unknown as SupervisorApi;
        return { supervisor, stops };
    }

    it('(c) a linked window — handed the host’s hosting and supervisor — stops none of them and closes none of the hosting', async () => {
        const called: string[] = [];
        const hosting = new Proxy({ frontDoorPort: 47111, routes: () => [], configuredHosts: () => [], browserTrust: () => ({ caPem: null, reason: 'x' }), externalFrontDoor: { running: false, reason: 'x' }, onFrontDoorChange: () => () => {}, engines: { envFor: () => ({}) } } as Record<string, unknown>, {
            get: (target, key: string) => (key in target ? target[key] : (...args: unknown[]) => { called.push(key); return args; }),
        }) as unknown as HostingApi;
        const { supervisor, stops } = hostSupervisor();
        dir = await mkdtemp(join(tmpdir(), 'genie-p5a3-linked-'));
        services = await composeServices({ userData: dir, pty: pty(), v1Settings: () => null, caddyBin: null, hosting, supervisor });
        await services.shutdown();
        expect(stops).toEqual([]);
        expect(called).toEqual([]);
    });

    it('(e) CONTROL, the emergency path (no host): the window stops its own supervised processes, as today', async () => {
        dir = await mkdtemp(join(tmpdir(), 'genie-p5a3-own-'));
        services = await composeServices({ userData: dir, pty: pty(), v1Settings: () => null, caddyBin: null });
        services.supervisor.start({ id: 'proc:queue', workspaceId: 'ws', name: 'queue', command: 'worker', cwd: dir, restart: 'always' });
        expect(services.supervisor.status('proc:queue')?.state).toBe('running');
        await services.shutdown();
        expect(services.supervisor.status('proc:queue')?.state).toBe('stopped');
    });
});
