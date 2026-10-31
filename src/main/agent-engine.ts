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

/** Where agents run: in `genie-host` (the default), or in the window's process (`GENIE_AGENT_HOST=in-process`, diagnosis). */
export function agentHostMode(env: NodeJS.ProcessEnv): 'process' | 'in-process' {
    return env.GENIE_AGENT_HOST?.trim().toLowerCase() === 'in-process' ? 'in-process' : 'process';
}

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
    /** How the host was found at boot: `adopted` = its agents were already running (the window restarted or crashed). */
    readonly how: EngineLink['how'];
    /** Stop gracefully and end the host (a quit, an upgrade): sessions stopped and verified, then the process gone. */
    shutdown(waitMs?: number): Promise<void>;
}

const killPid = (pid: number): void => {
    try { process.kill(pid); } catch { /* already gone */ }
};

/**
 * Find (adopt, replace or start) the host and connect to it. `null` when it cannot be had: the caller runs the engine
 * in-process, and the reason is on the Deck — never a quiet downgrade.
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
    const how = await link();
    if (how === null) {
        stopping = true;
        return null;
    }
    // A ledger nobody has read for a minute is unwatched: the host stops sending it (cheap, incremental subscriptions).
    const sweep = setInterval(() => client.sweepLedgers(), 30_000);
    sweep.unref?.();
    return {
        client,
        how,
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
