import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { reconcileEngines, engineStatuses, type ContainerState, type ReconcilePorts } from '../src/core/engine-reconcile.js';
import type { ServiceInstance } from '../src/core/services.js';
import { ServiceDriver, dockerRunnerOver } from '../src/main/service-driver.js';

/**
 * "GENIE COULD NOT ASK DOCKER" IS NOT "THE CONTAINER IS GONE" (Tynn #922). Found measuring #919 (queue item
 * 1119-180839-a2ee1d): the spawn host died mid-call, the client rejected the call (ESPAWNHOST), dockerRunnerOver turned
 * every rejection into exit 1, and #inspect read any non-zero exit as `absent`. Reconcile then told the person "its
 * container is not in Docker any more; remove the engine and add it again", about an engine that was running.
 *
 * Only Docker's own answer may read as absent ("No such container" / "No such object"). Anything else is UNKNOWN, with
 * its reason, and nothing is started, removed or advised on the strength of it.
 */

type Exec = Parameters<typeof dockerRunnerOver>[0];
const answering = (r: { stdout: string; stderr?: string; exitCode: number }): Exec => async () => ({ stdout: r.stdout, exitCode: r.exitCode, streams: { stdout: r.stdout, stderr: r.stderr ?? '' } });
const rejecting = (message: string, code: string): Exec => async () => { throw Object.assign(new Error(message), { code }); };

describe('the Docker state read (Tynn #922)', () => {
    it('THE FAILURE: the spawn host lost mid-call reads as unknown with its reason, never absent', async () => {
        const driver = new ServiceDriver(dockerRunnerOver(rejecting('the spawn host exited (code 1)', 'ESPAWNHOST')));
        const state = await driver.status('genie-postgres-17');
        expect(state).not.toEqual({ state: 'absent' });
        expect(state).toMatchObject({ state: 'unknown' });
        expect((state as { reason?: string }).reason).toMatch(/spawn host exited/);
    });

    it('CONTROL: Docker saying the container does not exist still reads as absent', async () => {
        const driver = new ServiceDriver(dockerRunnerOver(answering({ stdout: '[]', stderr: 'Error: No such container: genie-postgres-17', exitCode: 1 })));
        expect(await driver.status('genie-postgres-17')).toEqual({ state: 'absent' });
    });

    it('CONTROL: a running container still reads as running', async () => {
        const stdout = '[{"State":{"Status":"running","StartedAt":"2026-11-01T00:00:00Z"}}]';
        const driver = new ServiceDriver(dockerRunnerOver(answering({ stdout, exitCode: 0 })));
        expect(await driver.status('genie-postgres-17')).toEqual({ state: 'running', since: '2026-11-01T00:00:00Z' });
    });

    it('any other failure (a timeout, the daemon refusing) is unknown with Docker\'s words, not absent', async () => {
        const timedOut = new ServiceDriver(dockerRunnerOver(rejecting('docker did not answer', 'ETIMEDOUT')));
        expect(await timedOut.status('x')).toMatchObject({ state: 'unknown' });
        const daemon = new ServiceDriver(dockerRunnerOver(answering({ stdout: '', stderr: 'Cannot connect to the Docker daemon at npipe:////./pipe/docker_engine', exitCode: 1 })));
        const state = await daemon.status('x');
        expect(state).toMatchObject({ state: 'unknown' });
        expect((state as { reason?: string }).reason).toMatch(/Cannot connect to the Docker daemon/);
    });
});

/** The real spawn host, killed while it holds the call (its fixture takes 5 s per exec). */
describe('the real spawn host, killed mid-call (Tynn #922)', () => {
    let stop: (() => Promise<void>) | null = null;
    afterEach(async () => { await stop?.(); stop = null; });

    it('the read answers unknown, naming the spawn host, not absent', async () => {
        const host = await import('../src/main/spawn-host-client.js');
        const runner = await import('../src/main/toolchain-runner.js');
        const client = host.startSpawnHost({
            entry: fileURLToPath(new URL('./fixtures/slow-spawn-host.ts', import.meta.url)),
            execArgv: ['--import', 'tsx'],
            env: { SLOW_SPAWN_MS: '5000' },
        });
        host.routeExecThroughSpawnHost(client);
        stop = async () => { host.routeExecThroughSpawnHost(null); await client.stop(); };
        const driver = new ServiceDriver(dockerRunnerOver(runner.execFileRunner));
        const reading = driver.status('genie-postgres-17');
        // Killed once it is holding the call: its pid is known once it has started.
        for (let i = 0; i < 200 && client.pid === null; i += 1) await new Promise((r) => setTimeout(r, 25));
        await new Promise((r) => setTimeout(r, 1_000));
        process.kill(client.pid!);
        const state = await reading;
        expect(state).toMatchObject({ state: 'unknown' });
        expect((state as { reason?: string }).reason).toMatch(/spawn host/);
    }, 30_000);
});

const PG: ServiceInstance = { id: 'svc_pg', engine: 'postgres', version: '17', scope: { kind: 'dedicated', workspaceId: 'example' }, publishedPort: 4102, credentials: {}, active: true };

describe('Genie start and the Services view on an unknown reading (Tynn #922)', () => {
    const ports = (state: ContainerState, started: string[]): ReconcilePorts => ({
        available: async () => ({ ok: true, version: '28.1.0' }),
        instances: () => [PG],
        state: async () => state,
        personStopped: () => new Set(),
        start: async (id) => { started.push(id); },
        answers: async () => true,
        now: () => 0,
        sleep: async () => {},
    });

    it('reconcile: an unknown engine is neither started nor called gone; the outcome says the state could not be read, and why', async () => {
        const started: string[] = [];
        const report = await reconcileEngines(ports({ unknown: 'the spawn host exited (code 1)' }, started), { timeoutMs: 1_000, pollMs: 100 });
        expect(started).toEqual([]);
        expect(report.engines[0]).toMatchObject({ id: 'svc_pg', outcome: 'failed' });
        expect((report.engines[0] as { reason?: string }).reason).toMatch(/could not be read.*spawn host exited/);
    });

    it('the Services view: status unknown, with the reason as its note', async () => {
        const [view] = await engineStatuses(ports({ unknown: 'the spawn host exited (code 1)' }, []));
        expect(view).toMatchObject({ status: 'unknown', note: 'the spawn host exited (code 1)' });
    });
});
