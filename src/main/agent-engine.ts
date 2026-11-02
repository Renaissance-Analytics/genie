import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseHostRecord } from '../core/engine-protocol.js';
import type { AgentId, AgentRecord } from '../core/identity.js';
import { linkToHost, pidAlive, type EngineLaunchPorts, type EngineLink } from './engine-launch.js';
import { SessionEngineClient, type EngineClientOptions } from './session-engine-client.js';
import type { SessionHost } from './session-host.js';

/**
 * THE WINDOW'S AGENT ENGINE (the host split, phase 1): `genie-host` behind a `SessionEngineClient`, or — the fallback —
 * a `SessionHost` in this process. main.ts holds one `AgentEngine` and calls the same surface on either; a command's
 * answer may be a promise (the host's), so call sites that use an answer `await` it.
 */
export type AgentEngine = SessionHost | SessionEngineClient;

/** Reconnect backoff after the link drops (Genie 1's host-loss recovery, `g1:main/terminal/host-service.ts:1428`). */
export const RECONNECT_BACKOFF_MS: readonly number[] = [1_000, 2_000, 4_000, 8_000];

export interface AgentEngineLinkOptions {
    readonly callbacks: EngineClientOptions;
    readonly launch: Omit<EngineLaunchPorts, 'askShutdown' | 'kill'>;
    readonly records: () => readonly AgentRecord[];
    /** A stop the host could not verify, or the host itself lost: main says it on the Deck. */
    readonly onError: (kind: 'stop-unverified' | 'agent-host', error: Error) => void;
    readonly agentName: (id: AgentId) => string;
    readonly log: (line: string) => void;
    readonly sleep?: (ms: number) => Promise<void>;
}

/** The link's state, for the quit (no reconnect once stopping) and for what the window reports. */
export interface AgentEngineLink {
    readonly client: SessionEngineClient;
    /**
     * How the host was found at boot: `adopted` = its agents were already running (the window restarted or crashed);
     * `unreachable` = a LIVE host would not link — the client keeps reconnecting and NOTHING runs agents in this process.
     */
    readonly how: EngineLink['how'] | 'unreachable';
    /** Stop gracefully and end the host (a quit, an upgrade): sessions stopped and verified, then the process gone. */
    shutdown(waitMs?: number): Promise<void>;
    /**
     * "Just close the UI" (P1b): the host is told it is left running and the link let go — no reconnect from here, and
     * never `engine.shutdown`. Its agents, terminals and kept processes go on; the next window adopts the host.
     */
    leave(): Promise<void>;
    /** `true` while this window holds the host: not after `shutdown` or `leave` (an upgrade has ended it; nothing is kept). */
    readonly live: boolean;
}

const killPid = (pid: number): void => {
    try { process.kill(pid); } catch { /* already gone */ }
};

/**
 * Find (adopt, replace or start) the host and connect to it. `null` when it cannot be had at all: the caller falls back
 * to the EMERGENCY in-process engine and says so on the Deck — never a quiet downgrade, and never a mode anyone chooses
 * (the owner, 2026-11-01: "we split host from UI for good"; plan §4.1).
 */
export async function connectAgentEngine(options: AgentEngineLinkOptions): Promise<AgentEngineLink | null> {
    const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    let stopping = false;
    let reconnecting = false;
    // Late-bound: the client's onDisconnected reconnects through `link` below.
    let reconnect = (): void => {};
    const client = new SessionEngineClient({
        ...options.callbacks,
        records: options.records,
        onStopUnverified: (id, reason) => options.onError('stop-unverified', new Error(`${options.agentName(id)}: ${reason}`)),
        onDisconnected: (reason) => { if (!stopping) { options.log(`agent host link lost: ${reason}`); reconnect(); } },
        log: options.log,
    });
    const launchPorts: EngineLaunchPorts = {
        ...options.launch,
        kill: killPid,
        // A host of another build: told to stop gracefully through its own token, before a new one starts.
        askShutdown: async (record) => {
            const old = await linkToHost({ ...options.launch, build: record.build, spawnHost: () => null, startTimeoutMs: 1 }).catch(() => null);
            if (!old) return;
            const peer = new SessionEngineClient();
            if ((await peer.connect(old.transport, old.token)).ok) await peer.shutdown();
            peer.disconnect();
        },
    };
    const link = async (): Promise<EngineLink['how'] | null> => {
        try {
            const found = await linkToHost(launchPorts);
            const connected = await client.connect(found.transport, found.token);
            if (!connected.ok) { options.log(`agent host refused this window: ${connected.reason}`); found.transport.close(); return null; }
            options.log(`agent host ${found.how} pid=${found.record.pid} build=${found.record.build}`);
            return found.how;
        } catch (error) {
            options.log(`agent host unavailable: ${error instanceof Error ? error.message : String(error)}`);
            return null;
        }
    };
    reconnect = () => {
        if (reconnecting || stopping) return;
        reconnecting = true;
        void (async () => {
            for (let attempt = 0; !stopping; attempt += 1) {
                await sleep(RECONNECT_BACKOFF_MS[Math.min(attempt, RECONNECT_BACKOFF_MS.length - 1)]!);
                if (stopping) break;
                const how = await link();
                if (how !== null) {
                    // A host that had to be STARTED again lost its agents with the old one: said, never silent.
                    if (how !== 'adopted') options.onError('agent-host', new Error('Genie\'s agent host stopped unexpectedly and was started again; agents that were running stopped with it. Start them again.'));
                    break;
                }
            }
            reconnecting = false;
        })();
    };
    // LIVE HOST, NO FALLBACK (genie-test-windows, 2026-11-01): a window that fell back beside a running host ran the
    // fallback's boot sweep and ended that host's eleven providers. The fallback is for a host that cannot start at all.
    const liveHostPid = (): number | null => {
        const read = options.launch.readFile ?? ((file: string) => { try { return readFileSync(file, 'utf8'); } catch { return null; } });
        const record = parseHostRecord(read(join(options.launch.runtimeDir, 'host.json')));
        return record !== null && (options.launch.alive ?? pidAlive)(record.pid) ? record.pid : null;
    };
    const found = await link();
    let how: AgentEngineLink['how'];
    if (found !== null) how = found;
    else {
        const live = liveHostPid();
        if (live === null) {
            stopping = true;
            return null;
        }
        how = 'unreachable';
        options.onError('agent-host', new Error(`Genie's agent host (pid ${live}) is running but not answering this window; Genie keeps trying to reach it and runs no agents of its own meanwhile.`));
        reconnect();
    }
    // A ledger nobody has read for a minute is unwatched: the host stops sending it (cheap, incremental subscriptions).
    const sweep = setInterval(() => client.sweepLedgers(), 30_000);
    sweep.unref?.();
    return {
        client,
        how,
        get live() { return !stopping; },
        leave: async () => {
            stopping = true;
            clearInterval(sweep);
            const kept = await client.leaveRunning().catch(() => false);
            options.log(kept ? 'agent host left running: the UI closed' : 'agent host did not take "left running"; it keeps its own idle exit');
            client.disconnect();
        },
        shutdown: async (waitMs = 10_000) => {
            stopping = true;
            clearInterval(sweep);
            const pid = client.welcome?.pid ?? null;
            await client.shutdown().catch(() => false);
            const until = Date.now() + waitMs;
            while (pid !== null && pidAlive(pid) && Date.now() < until) await sleep(100);
            if (pid !== null && pidAlive(pid)) { options.log(`agent host pid=${pid} did not exit within ${waitMs} ms; ending it`); killPid(pid); }
            client.disconnect();
        },
    };
}
