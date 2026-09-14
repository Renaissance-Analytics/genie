import type net from 'node:net';
import { connectPublisher, type FrameCodec, type PublisherConnection } from './control-channel';
import type { DispatchFrame, ShuttleResponse } from './core';
import type { ShuttleManifest } from './manifest-store';
import { WIRE_MISMATCH_PREFIX } from './publisher-gate';
import type { ShuttleTopology } from './topology-store';

/**
 * ENSURE A SHUTTLE — or serve in-process, and say why.
 *
 * genie#346 Phase 1, `.ai/plans/genie-mcp-shuttle-spec.md` §3.3 and §9.1. Genie's
 * side of the shuttle's lifetime. At boot it ends in exactly one state:
 *
 *  - **attached** to a shuttle that was already running — the one that outlived
 *    the previous Genie, which is the whole point;
 *  - **spawned** one because none was running, then attached;
 *  - **replaced** a shuttle speaking another wire generation (a deep upgrade,
 *    §9.3.1), then attached to the new one;
 *  - **in-process**, with the reason — today's behaviour, always available. The app
 *    must never fail to start because a shuttle would not.
 *
 * ## The watchdog is event-driven
 *
 * A live attachment is watched on the one event that means the shuttle is gone:
 * its control connection closing. No poll. On that event it tries again, a few
 * times with a short backoff, and only when every attempt fails reports
 * in-process — at which point the caller binds the port itself and the session
 * stays there. Flapping back to a shuttle later would have to take the port away
 * from a Genie that is already serving it.
 *
 * Two closes are NOT deaths. `displaced` means a newer Genie authenticated and took
 * over — this one is on its way out, and fighting for the shuttle would evict the
 * Genie that replaced it. And a close this supervisor asked for is just that.
 *
 * ## What it will not do
 *
 * Kill a shuttle it could not authenticate to. Only a wire-generation mismatch is
 * evidence the running shuttle is an older one of ours; a refused secret is a
 * process this Genie cannot prove is its own.
 *
 * Every effect — the pipe, the spawn, stopping a stale shuttle, time — is
 * injected, so each of those states is tested against real shuttles on real pipes.
 */

export type SpawnOutcome =
    | { kind: 'started' }
    | { kind: 'refused'; reason: string; error: string }
    | { kind: 'failed'; error: string };

export type ShuttleStatus =
    | { mode: 'shuttle'; how: 'attached' | 'spawned' | 'replaced' }
    | { mode: 'in-process'; reason: string }
    | { mode: 'displaced'; reason: string };

export interface ShuttleSupervisorDeps {
    /** Open the control pipe. */
    connect(): net.Socket;
    codec: FrameCodec;
    /** Read at every attempt: a shuttle this Genie spawns may be first to create it. */
    secret(): string;
    wireGeneration: number;
    /** Monotonic per Genie boot. */
    generation: number;
    /** Run one dispatched call. Must not reject. */
    run(frame: DispatchFrame): Promise<ShuttleResponse>;
    /** Start a shuttle process and report how that went. */
    spawnShuttle(): Promise<SpawnOutcome>;
    /** Stop the running shuttle that refused this wire generation. */
    stopStaleShuttle(): Promise<void>;
    /** How long a connected pipe may take to welcome or refuse. */
    welcomeTimeoutMs?: number;
    /** The watchdog's attempts after a death, one delay each. */
    retryDelaysMs?: number[];
    log?(line: string): void;
}

export interface ShuttleSupervisorEvents {
    onStatus?(status: ShuttleStatus): void;
}

export interface ShuttleSupervisor {
    /** Resolve once Genie is attached or knows it must serve in-process. */
    start(): Promise<ShuttleStatus>;
    /** The surface to serve. Kept, and sent again to every shuttle attached later. */
    publish(manifest: ShuttleManifest): void;
    /** The routes to serve. Kept and re-sent like {@link publish}. */
    topology(topology: ShuttleTopology): void;
    status(): ShuttleStatus | null;
    /** Close the attachment and stop watching. */
    stop(): void;
}

const DEFAULT_WELCOME_TIMEOUT_MS = 5_000;
const DEFAULT_RETRY_DELAYS_MS = [0, 250, 1_000, 5_000];

type Attempt =
    | { kind: 'welcomed'; publisher: PublisherConnection; ended: Promise<{ displaced: boolean; reason: string }> }
    | { kind: 'absent'; reason: string }
    | { kind: 'refused'; reason: string };

export function createShuttleSupervisor(
    deps: ShuttleSupervisorDeps,
    events: ShuttleSupervisorEvents = {},
): ShuttleSupervisor {
    const welcomeTimeoutMs = deps.welcomeTimeoutMs ?? DEFAULT_WELCOME_TIMEOUT_MS;
    const retryDelaysMs = deps.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
    const log = (line: string) => deps.log?.(`[mcp-shuttle] ${line}`);

    let stopped = false;
    let current: PublisherConnection | null = null;
    let status: ShuttleStatus | null = null;
    let latestManifest: ShuttleManifest | null = null;
    let latestTopology: ShuttleTopology | null = null;

    const report = (next: ShuttleStatus): ShuttleStatus => {
        status = next;
        log(next.mode === 'shuttle' ? `shuttle (${next.how})` : `${next.mode}: ${next.reason}`);
        events.onStatus?.(next);
        return next;
    };

    /** One connection attempt, resolved as soon as its outcome is known. */
    const attach = (): Promise<Attempt> =>
        new Promise((resolve) => {
            let connected = false;
            let welcomed = false;
            let displaced = false;
            let settled = false;
            let endedResolve: (v: { displaced: boolean; reason: string }) => void = () => {};
            const ended = new Promise<{ displaced: boolean; reason: string }>((r) => (endedResolve = r));
            const settle = (attempt: Attempt) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                resolve(attempt);
            };

            const publisher = connectPublisher({
                connect: () => {
                    const socket = deps.connect();
                    socket.once('connect', () => (connected = true));
                    return socket;
                },
                codec: deps.codec,
                secret: deps.secret(),
                wireGeneration: deps.wireGeneration,
                generation: deps.generation,
                run: (frame) => deps.run(frame),
                onWelcome: () => {
                    welcomed = true;
                    settle({ kind: 'welcomed', publisher, ended });
                },
                onDisplaced: () => (displaced = true),
                onClosed: (reason) => {
                    if (welcomed) {
                        endedResolve({ displaced, reason });
                        return;
                    }
                    settle(connected ? { kind: 'refused', reason } : { kind: 'absent', reason });
                },
            });
            const timer = setTimeout(() => {
                publisher.close();
                settle({ kind: 'refused', reason: `The MCP shuttle did not answer within ${welcomeTimeoutMs}ms.` });
            }, welcomeTimeoutMs);
            timer.unref?.();
        });

    const adopt = (attempt: Extract<Attempt, { kind: 'welcomed' }>, how: 'attached' | 'spawned' | 'replaced') => {
        current = attempt.publisher;
        if (latestManifest) attempt.publisher.publish(latestManifest);
        if (latestTopology) attempt.publisher.topology(latestTopology);
        void attempt.ended.then(({ displaced, reason }) => {
            if (current === attempt.publisher) current = null;
            if (stopped) return;
            if (displaced) {
                report({ mode: 'displaced', reason });
                return;
            }
            log(`the shuttle connection ended: ${reason}`);
            void recover();
        });
        return report({ mode: 'shuttle', how });
    };

    /** Start a shuttle and attach to it. `how` is what a successful attach is called. */
    const spawnAndAttach = async (how: 'spawned' | 'replaced'): Promise<ShuttleStatus> => {
        const spawned = await deps.spawnShuttle();
        if (spawned.kind === 'failed') return { mode: 'in-process', reason: spawned.error };
        if (spawned.kind === 'refused' && spawned.reason !== 'control-in-use') {
            return { mode: 'in-process', reason: spawned.error };
        }
        const attempt = await attach();
        if (attempt.kind === 'welcomed') {
            // A lost race is still an attachment to a shuttle that was already there.
            return adopt(attempt, spawned.kind === 'refused' ? 'attached' : how);
        }
        return { mode: 'in-process', reason: attempt.reason };
    };

    /** Everything one boot or one recovery tries, in order. Never reports on its own. */
    const ensureOnce = async (): Promise<ShuttleStatus> => {
        const attempt = await attach();
        if (attempt.kind === 'welcomed') return adopt(attempt, 'attached');
        if (attempt.kind === 'refused') {
            if (!attempt.reason.startsWith(WIRE_MISMATCH_PREFIX)) {
                return { mode: 'in-process', reason: attempt.reason };
            }
            log(`replacing a shuttle from another wire generation: ${attempt.reason}`);
            try {
                await deps.stopStaleShuttle();
            } catch (e) {
                return { mode: 'in-process', reason: `Could not stop the older MCP shuttle: ${(e as Error).message}` };
            }
            return spawnAndAttach('replaced');
        }
        return spawnAndAttach('spawned');
    };

    const recover = async (): Promise<void> => {
        let last: ShuttleStatus | null = null;
        for (const delay of retryDelaysMs) {
            if (delay > 0) await new Promise((r) => setTimeout(r, delay));
            if (stopped) return;
            last = await ensureOnce();
            if (stopped) return;
            if (last.mode === 'shuttle') return;
        }
        report(last ?? { mode: 'in-process', reason: 'The MCP shuttle stopped and could not be brought back.' });
    };

    return {
        async start() {
            const result = await ensureOnce();
            return result.mode === 'shuttle' ? result : report(result);
        },
        publish(manifest) {
            latestManifest = manifest;
            current?.publish(manifest);
        },
        topology(topology) {
            latestTopology = topology;
            current?.topology(topology);
        },
        status: () => status,
        stop() {
            stopped = true;
            current?.close();
            current = null;
        },
    };
}
