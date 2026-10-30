import type { ServiceInstance } from './services.js';

/**
 * SERVICE ENGINES AT GENIE START (§6.6) — the pure half of "the engines I added are there after a restart".
 *
 * Nothing used to look at the registered engines when Genie started, and nothing asked whether Docker
 * was running at all: with the daemon down every `docker container inspect` failed and the Services
 * tab said `absent` — as if the engine had been deleted. Here:
 *
 *   - Docker is asked ONCE first. Down (or not installed) → every instance is reported as
 *     `docker-not-running` with Docker's own reason, and nothing is started or inspected.
 *   - Up → every registered instance that is not running and that the PERSON did not stop is started,
 *     then waited for: running per `docker inspect` AND answering on its loopback port (the engine's
 *     own handshake where it has one — see `readinessHandshake`), bounded by a deadline. An engine the
 *     person stopped stays stopped across a restart.
 *   - An engine taken over from Genie 1 that NO workspace uses (no slice) is never started: it would run for
 *     nobody. The take-over planner (core/v1-services.ts) already leaves those stopped; a later boot must not wake
 *     them (hosting ship line H5). One that is already running is reported as running and left alone.
 *   - An engine that is up (found running, or started) gets `restore` — what lives only in its memory put back
 *     (a shared Redis's workspace users; Docker restarts a container on a reboot without asking Genie).
 *
 * Every effect is a port; the clock and the sleep are injected, so the bound is tested without waiting.
 */

export type DockerAvailability = { ok: true; version: string } | { ok: false; reason: string };
export type ContainerState = 'running' | 'exited' | 'absent';
/** What the Services tab shows for an instance: Docker's state, or that Docker itself is not there to ask. */
export type EngineStatus = ContainerState | 'docker-not-running';

export interface EngineStatusView {
    readonly instance: ServiceInstance;
    readonly status: EngineStatus;
    /** Present only when Docker is not running: Docker's own reason (daemon down vs. not installed). */
    readonly note?: string;
}

export interface EnginePorts {
    readonly available: () => Promise<DockerAvailability>;
    readonly instances: () => readonly ServiceInstance[];
    readonly state: (id: string) => Promise<ContainerState>;
}

export interface ReconcilePorts extends EnginePorts {
    /** The instance ids the person stopped (persisted; machine-local). */
    readonly personStopped: () => ReadonlySet<string>;
    /**
     * An engine only HIBERNATED workspaces use (core/hibernate-engines.ts `asleepOnlyEngine`; parity audit #12): left
     * stopped at Genie start — a sleeping workspace stays asleep through a restart, as in Genie 1. Absent = none.
     */
    readonly asleepOnly?: (instance: ServiceInstance) => boolean;
    readonly start: (id: string) => Promise<void>;
    /** ONE readiness probe of the engine on 127.0.0.1:<publishedPort>; true when it answers. */
    readonly answers: (instance: ServiceInstance) => Promise<boolean>;
    readonly now: () => number;
    readonly sleep: (ms: number) => Promise<void>;
    /** For an engine found already RUNNING: put back what lives only in its memory. A failure is the engine's outcome. */
    readonly restore?: (instance: ServiceInstance) => Promise<void>;
}

/** An engine taken over from Genie 1 that no workspace holds a slice of: it gives nobody any env. */
export function unusedAdopted(i: ServiceInstance): boolean {
    return i.adopted === 'v1' && Object.keys(i.slices ?? {}).length === 0;
}

export type EngineOutcome =
    | { readonly id: string; readonly outcome: 'running' }
    | { readonly id: string; readonly outcome: 'started' }
    | { readonly id: string; readonly outcome: 'person-stopped' }
    /** Only hibernated workspaces use it: left stopped until one of them wakes (parity audit #12). */
    | { readonly id: string; readonly outcome: 'asleep' }
    | { readonly id: string; readonly outcome: 'unused'; readonly reason: string }
    | { readonly id: string; readonly outcome: 'docker-not-running'; readonly reason: string }
    | { readonly id: string; readonly outcome: 'absent'; readonly reason: string }
    | { readonly id: string; readonly outcome: 'failed'; readonly reason: string }
    | { readonly id: string; readonly outcome: 'not-ready'; readonly reason: string };

export interface ReconcileReport {
    /** `null` when there was nothing registered, so Docker was never asked. */
    readonly docker: DockerAvailability | null;
    readonly engines: readonly EngineOutcome[];
    /** The pass itself failed (not one engine): what went wrong, so a failure is not read as "nothing registered". */
    readonly error?: string;
}

export interface ReadinessBound {
    readonly timeoutMs: number;
    readonly pollMs: number;
}

export const DEFAULT_READINESS: ReadinessBound = { timeoutMs: 60_000, pollMs: 500 };

const label = (i: ServiceInstance) => `${i.engine} ${i.version} on 127.0.0.1:${i.publishedPort}`;

/** Every registered instance with its status; Docker is asked once, and only when something is registered. */
export async function engineStatuses(ports: EnginePorts): Promise<EngineStatusView[]> {
    const instances = ports.instances();
    if (instances.length === 0) return [];
    const docker = await ports.available();
    if (!docker.ok) return instances.map((instance): EngineStatusView => ({ instance, status: 'docker-not-running', note: docker.reason }));
    return Promise.all(instances.map(async (instance): Promise<EngineStatusView> => ({ instance, status: await ports.state(instance.id) })));
}

/** Running per Docker AND answering on its port, polled until the bound. */
export async function waitReady(instance: ServiceInstance, ports: Pick<ReconcilePorts, 'state' | 'answers' | 'now' | 'sleep'>, bound: ReadinessBound = DEFAULT_READINESS): Promise<boolean> {
    const deadline = ports.now() + bound.timeoutMs;
    for (;;) {
        if ((await ports.state(instance.id)) === 'running' && (await ports.answers(instance).catch(() => false))) return true;
        if (ports.now() >= deadline) return false;
        await ports.sleep(bound.pollMs);
    }
}

export async function reconcileEngines(ports: ReconcilePorts, bound: ReadinessBound = DEFAULT_READINESS): Promise<ReconcileReport> {
    const instances = ports.instances();
    if (instances.length === 0) return { docker: null, engines: [] };
    const docker = await ports.available();
    if (!docker.ok) return { docker, engines: instances.map((i): EngineOutcome => ({ id: i.id, outcome: 'docker-not-running', reason: docker.reason })) };
    const stopped = ports.personStopped();
    const engines = await Promise.all(
        instances.map(async (i): Promise<EngineOutcome> => {
            if (stopped.has(i.id)) return { id: i.id, outcome: 'person-stopped' };
            const state = await ports.state(i.id);
            if (state !== 'running' && ports.asleepOnly?.(i) === true) return { id: i.id, outcome: 'asleep' };
            if (state !== 'running' && unusedAdopted(i)) return { id: i.id, outcome: 'unused', reason: `${label(i)}: taken over from Genie 1, but no workspace uses it; left stopped` };
            if (state === 'running') {
                try {
                    await ports.restore?.(i);
                } catch (error) {
                    return { id: i.id, outcome: 'failed', reason: `${label(i)} is running, but its workspaces' users could not be put back: ${error instanceof Error ? error.message : String(error)}` };
                }
                return { id: i.id, outcome: 'running' };
            }
            if (state === 'absent') return { id: i.id, outcome: 'absent', reason: `${label(i)}: its container is not in Docker any more; remove the engine and add it again (its data volume is kept unless you delete it)` };
            try {
                await ports.start(i.id);
            } catch (error) {
                return { id: i.id, outcome: 'failed', reason: `${label(i)} did not start: ${error instanceof Error ? error.message : String(error)}` };
            }
            if (!(await waitReady(i, ports, bound))) return { id: i.id, outcome: 'not-ready', reason: `${label(i)} was started but did not answer within ${Math.round(bound.timeoutMs / 1000)} s` };
            return { id: i.id, outcome: 'started' };
        }),
    );
    return { docker, engines };
}

/**
 * What "answering" means per engine. A bare TCP connect is NOT enough: Docker's port proxy can accept on
 * the host side whether or not the engine inside is listening (then close). So where the protocol allows a
 * cheap, unauthenticated first exchange, readiness is that exchange:
 *
 *   - postgres: an SSLRequest; the server answers one byte, `S` or `N`.
 *   - redis: `PING`; the server answers `+PONG`, or `-NOAUTH…`/`-ERR…` — any RESP reply is Redis answering.
 *   - mysql / mariadb: nothing sent; the server greets first (a handshake packet).
 *   - websockets (Sockudo): an HTTP request; any `HTTP/` status line (HTTP and the upgrade share its port).
 *   - mongo: no unauthenticated greeting without building BSON — a connection that is accepted and NOT
 *     closed by the peer within the probe's window (see the net port). Weaker; said, not hidden.
 */
export interface ReadinessHandshake {
    readonly send: Uint8Array | null;
    readonly expect: ((reply: Uint8Array) => boolean) | null;
}

const ascii = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0));
const startsWith = (reply: Uint8Array, prefix: string) => prefix.split('').every((c, i) => reply[i] === c.charCodeAt(0));

export function readinessHandshake(engine: string): ReadinessHandshake {
    switch (engine) {
        case 'postgres':
            // Int32 length 8, Int32 80877103 (the SSLRequest code).
            return { send: Uint8Array.from([0, 0, 0, 8, 0x04, 0xd2, 0x16, 0x2f]), expect: (r) => r.length > 0 && (r[0] === 0x53 || r[0] === 0x4e) };
        case 'redis':
            return { send: ascii('PING\r\n'), expect: (r) => r.length > 0 && (r[0] === 0x2b || r[0] === 0x2d) };
        case 'mysql':
        case 'mariadb':
            return { send: null, expect: (r) => r.length > 4 };
        case 'websockets':
            return { send: ascii('GET / HTTP/1.0\r\n\r\n'), expect: (r) => startsWith(r, 'HTTP/') };
        default:
            return { send: null, expect: null };
    }
}
