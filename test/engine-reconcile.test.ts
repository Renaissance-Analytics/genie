import { describe, expect, it } from 'vitest';
import { engineStatuses, readinessHandshake, reconcileEngines, waitReady, type ContainerState, type DockerAvailability, type ReconcilePorts } from '../src/core/engine-reconcile.js';
import type { ServiceInstance } from '../src/core/services.js';

/**
 * SERVICE ENGINES AT GENIE START — the pure half. Nothing used to look at the registered engines when Genie
 * started, and with the Docker daemon down the Services tab said `absent`. Every effect here is a fake that
 * COUNTS: Docker's availability, each container's state, each start, each readiness probe; the clock and the
 * sleep are fake, so the readiness bound is tested without waiting for it.
 */

const inst = (id: string, engine: string, version: string, port: number): ServiceInstance => ({
    id, engine, version, scope: { kind: 'dedicated', workspaceId: 'example' }, publishedPort: port, credentials: {}, active: true,
});
const PG = inst('svc_pg', 'postgres', '17', 4102);
const REDIS = inst('svc_redis', 'redis', '7', 4104);
const MYSQL = inst('svc_mysql', 'mysql', '8', 4106);

const UP: DockerAvailability = { ok: true, version: '28.1.0' };
const DOWN: DockerAvailability = { ok: false, reason: 'Docker is installed but its daemon is not running; start Docker Desktop (or dockerd) and try again' };

function world(input: { docker?: DockerAvailability; instances: ServiceInstance[]; states: Record<string, ContainerState>; stopped?: string[]; answersAfter?: Record<string, number>; startFails?: Record<string, string>; restoreFails?: Record<string, string> }) {
    const states = { ...input.states };
    const started: string[] = [];
    const restored: string[] = [];
    const probed: string[] = [];
    const inspected: string[] = [];
    let availableAsked = 0;
    let clock = 0;
    let slept = 0;
    const probesSinceStart: Record<string, number> = {};
    const ports: ReconcilePorts = {
        available: async () => { availableAsked++; return input.docker ?? UP; },
        instances: () => input.instances,
        state: async (id) => { inspected.push(id); return states[id] ?? 'absent'; },
        personStopped: () => new Set(input.stopped ?? []),
        start: async (id) => {
            const fail = input.startFails?.[id];
            if (fail) throw new Error(fail);
            started.push(id);
            states[id] = 'running';
            probesSinceStart[id] = 0;
        },
        answers: async (i) => {
            probed.push(i.id);
            probesSinceStart[i.id] = (probesSinceStart[i.id] ?? 0) + 1;
            return probesSinceStart[i.id]! > (input.answersAfter?.[i.id] ?? 0);
        },
        now: () => clock,
        sleep: async (ms) => { slept++; clock += ms; },
        restore: async (i) => {
            const fail = input.restoreFails?.[i.id];
            if (fail) throw new Error(fail);
            restored.push(i.id);
        },
    };
    return { ports, started, probed, inspected, restored, get availableAsked() { return availableAsked; }, get slept() { return slept; } };
}

const bound = { timeoutMs: 5_000, pollMs: 500 };

describe('reconcile at Genie start', () => {
    it('starts ONLY the registered engines that are not running and not stopped by the person — counted', async () => {
        const w = world({ instances: [PG, REDIS, MYSQL], states: { svc_pg: 'exited', svc_redis: 'running', svc_mysql: 'exited' }, stopped: ['svc_mysql'] });
        const report = await reconcileEngines(w.ports, bound);
        expect(w.started).toEqual(['svc_pg']);
        expect(report).toEqual({
            docker: UP,
            engines: [
                { id: 'svc_pg', outcome: 'started' },
                { id: 'svc_redis', outcome: 'running' },
                { id: 'svc_mysql', outcome: 'person-stopped' },
            ],
        });
    });

    it('WAITS for readiness after a start: the outcome is `started` only once the engine answers on its port', async () => {
        const w = world({ instances: [PG], states: { svc_pg: 'exited' }, answersAfter: { svc_pg: 3 } });
        const report = await reconcileEngines(w.ports, bound);
        expect(report.engines).toEqual([{ id: 'svc_pg', outcome: 'started' }]);
        // Three probes said no, the fourth said yes; between them, three bounded sleeps.
        expect(w.probed).toEqual(['svc_pg', 'svc_pg', 'svc_pg', 'svc_pg']);
        expect(w.slept).toBe(3);
    });

    it('an engine that never answers is `not-ready` at the bound, with the reason — the wait is BOUNDED', async () => {
        const w = world({ instances: [PG], states: { svc_pg: 'exited' }, answersAfter: { svc_pg: Number.POSITIVE_INFINITY } });
        const report = await reconcileEngines(w.ports, bound);
        expect(report.engines).toEqual([{ id: 'svc_pg', outcome: 'not-ready', reason: 'postgres 17 on 127.0.0.1:4102 was started but did not answer within 5 s' }]);
        expect(w.slept).toBe(bound.timeoutMs / bound.pollMs);
    });

    it('a start Docker refuses is `failed` with Docker’s words; the others are still reconciled', async () => {
        const w = world({ instances: [PG, REDIS], states: { svc_pg: 'exited', svc_redis: 'exited' }, startFails: { svc_pg: 'Error response from daemon: port is already allocated' } });
        const report = await reconcileEngines(w.ports, bound);
        expect(report.engines).toEqual([
            { id: 'svc_pg', outcome: 'failed', reason: 'postgres 17 on 127.0.0.1:4102 did not start: Error response from daemon: port is already allocated' },
            { id: 'svc_redis', outcome: 'started' },
        ]);
    });

    it('a registered engine whose container is gone is reported `absent` with what to do — nothing is started', async () => {
        const w = world({ instances: [REDIS], states: {} });
        const report = await reconcileEngines(w.ports, bound);
        expect(w.started).toEqual([]);
        expect(report.engines[0]).toMatchObject({ id: 'svc_redis', outcome: 'absent' });
    });

    it('Docker NOT running: every engine says so with Docker’s reason; nothing is inspected or started. Positive control: the same world with Docker up starts one', async () => {
        const down = world({ docker: DOWN, instances: [PG, REDIS], states: { svc_pg: 'exited', svc_redis: 'exited' } });
        const report = await reconcileEngines(down.ports, bound);
        expect(report).toEqual({ docker: DOWN, engines: [{ id: 'svc_pg', outcome: 'docker-not-running', reason: DOWN.reason }, { id: 'svc_redis', outcome: 'docker-not-running', reason: DOWN.reason }] });
        expect(down.started).toEqual([]);
        expect(down.inspected).toEqual([]);
        const up = world({ instances: [PG, REDIS], states: { svc_pg: 'exited', svc_redis: 'running' } });
        await reconcileEngines(up.ports, bound);
        expect(up.started).toEqual(['svc_pg']);
    });

    it('nothing registered: Docker is never asked (a machine without Docker and without engines boots quietly)', async () => {
        const w = world({ docker: DOWN, instances: [], states: {} });
        expect(await reconcileEngines(w.ports, bound)).toEqual({ docker: null, engines: [] });
        expect(w.availableAsked).toBe(0);
    });
});

describe('engines taken over from Genie 1 that no workspace uses (H5)', () => {
    // An adopted engine as core/v1-services.ts plans it: `slices` is who uses it.
    const adopted = (id: string, slices: NonNullable<ServiceInstance['slices']>): ServiceInstance => ({
        id, engine: 'postgres', version: '16', scope: { kind: 'shared' }, publishedPort: 4110, credentials: {}, active: false,
        adopted: 'v1', containerName: `genie-svc-${id}`, admin: { user: 'postgres', password: 'admin-example-pw' }, slices,
    });
    const UNUSED = adopted('svc_v1_unused', {});
    const USED = adopted('svc_v1_used', { 'example-a': { identifier: 'ws_example_a', password: 'example-a-pw', active: true } });

    it('an unused adopted engine is NOT started — counted; the used one beside it IS (the control)', async () => {
        const w = world({ instances: [UNUSED, USED], states: { svc_v1_unused: 'exited', svc_v1_used: 'exited' } });
        const report = await reconcileEngines(w.ports, bound);
        expect(w.started).toEqual(['svc_v1_used']);
        expect(report.engines).toEqual([
            { id: 'svc_v1_unused', outcome: 'unused', reason: 'postgres 16 on 127.0.0.1:4110: taken over from Genie 1, but no workspace uses it; left stopped' },
            { id: 'svc_v1_used', outcome: 'started' },
        ]);
    });

    it('an unused adopted engine that is already running is left running and reported so — never stopped by the reconcile', async () => {
        const w = world({ instances: [UNUSED], states: { svc_v1_unused: 'running' } });
        expect((await reconcileEngines(w.ports, bound)).engines).toEqual([{ id: 'svc_v1_unused', outcome: 'running' }]);
        expect(w.started).toEqual([]);
    });
});

describe('an engine found running gets what lives in its memory put back', () => {
    it('`restore` is called once for each engine found RUNNING — not for one it started (start does that), nor one the person stopped', async () => {
        const w = world({ instances: [PG, REDIS, MYSQL], states: { svc_pg: 'exited', svc_redis: 'running', svc_mysql: 'running' }, stopped: ['svc_mysql'] });
        await reconcileEngines(w.ports, bound);
        expect(w.restored).toEqual(['svc_redis']);
    });

    it('a restore that fails is that engine’s outcome, with the engine’s words; the others are untouched', async () => {
        const w = world({ instances: [REDIS, PG], states: { svc_redis: 'running', svc_pg: 'running' }, restoreFails: { svc_redis: 'redis 7: making the acl user for ws_example_a failed: ERR' } });
        expect((await reconcileEngines(w.ports, bound)).engines).toEqual([
            { id: 'svc_redis', outcome: 'failed', reason: "redis 7 on 127.0.0.1:4104 is running, but its workspaces' users could not be put back: redis 7: making the acl user for ws_example_a failed: ERR" },
            { id: 'svc_pg', outcome: 'running' },
        ]);
    });
});

describe('waitReady', () => {
    it('running per Docker is not enough: the engine must ANSWER; and answering is not enough: Docker must say running', async () => {
        const w = world({ instances: [PG], states: { svc_pg: 'exited' }, answersAfter: { svc_pg: 0 } });
        // Answers (the fake would), but the container is not running: never ready inside the bound.
        expect(await waitReady(PG, w.ports, bound)).toBe(false);
        expect(w.probed).toEqual([]);
        await w.ports.start('svc_pg');
        expect(await waitReady(PG, w.ports, bound)).toBe(true);
    });
});

describe('the status the Services tab shows', () => {
    it('Docker down → `docker-not-running` with the reason for EVERY instance, never `absent`; Docker up → the state Docker reads (positive control)', async () => {
        const down = world({ docker: DOWN, instances: [PG, REDIS], states: { svc_pg: 'running', svc_redis: 'exited' } });
        expect(await engineStatuses(down.ports)).toEqual([
            { instance: PG, status: 'docker-not-running', note: DOWN.reason },
            { instance: REDIS, status: 'docker-not-running', note: DOWN.reason },
        ]);
        expect(down.inspected).toEqual([]);
        const up = world({ instances: [PG, REDIS], states: { svc_pg: 'running', svc_redis: 'exited' } });
        expect(await engineStatuses(up.ports)).toEqual([{ instance: PG, status: 'running' }, { instance: REDIS, status: 'exited' }]);
    });
});

describe('what "answering" means per engine', () => {
    const bytes = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0));
    it('postgres: an SSLRequest, answered by one byte S or N; an empty reply (a proxy that closed) is not an answer', () => {
        const h = readinessHandshake('postgres');
        expect(Array.from(h.send!)).toEqual([0, 0, 0, 8, 4, 210, 22, 47]);
        expect(h.expect!(bytes('N'))).toBe(true);
        expect(h.expect!(bytes('S'))).toBe(true);
        expect(h.expect!(new Uint8Array())).toBe(false);
        expect(h.expect!(bytes('E'))).toBe(false);
    });

    it('redis: PING, answered by any RESP reply (+PONG, or -NOAUTH when a password is set)', () => {
        const h = readinessHandshake('redis');
        expect(new TextDecoder().decode(h.send!)).toBe('PING\r\n');
        expect(h.expect!(bytes('+PONG\r\n'))).toBe(true);
        expect(h.expect!(bytes('-NOAUTH Authentication required.\r\n'))).toBe(true);
        expect(h.expect!(new Uint8Array())).toBe(false);
    });

    it('mysql/mariadb greet first; reverb answers HTTP; mongo has no cheap greeting (connection-held only)', () => {
        for (const e of ['mysql', 'mariadb']) {
            const h = readinessHandshake(e);
            expect(h.send).toBeNull();
            expect(h.expect!(Uint8Array.from([0x4a, 0, 0, 0, 0x0a, 0x38]))).toBe(true);
            expect(h.expect!(new Uint8Array())).toBe(false);
        }
        expect(readinessHandshake('reverb').expect!(bytes('HTTP/1.1 404 Not Found'))).toBe(true);
        expect(readinessHandshake('mongo')).toEqual({ send: null, expect: null });
    });
});
