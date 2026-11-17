import { randomInt } from 'node:crypto';
import type { SupervisorApi } from './process-supervisor.js';
import { SERVER_HOST, decideIdle, serverCommand } from '../core/playwright-managed.js';

/**
 * GENIE'S PLAYWRIGHT SERVER (Tynn #604): `playwright run-server` as a supervised process, on 127.0.0.1 with the token in its
 * path. Started on demand by the first agent that asks, one server at a time (one version), and stopped when nothing has been
 * connected to it for the idle window. The supervisor owns the process: its log is in Processes, and a stop here is a stop.
 */

export const PLAYWRIGHT_SERVER_PROCESS_ID = 'genie-playwright-server';
const POLL_MS = 200;

/** A port for the server: uniform over 20000..39999 (crypto.randomInt; a modulo of random bytes favoured the low ports, CodeQL #113). */
export function playwrightServerPort(): number {
    return randomInt(20_000, 40_000);
}

export interface PlaywrightServerPorts {
    readonly supervisor: Pick<SupervisorApi, 'start' | 'stop' | 'status'>;
    readonly workspaceId: string;
    readonly cwd: string;
    /** Where a version's Playwright CLI is installed. */
    readonly cliDir: (version: string) => string;
    readonly allocatePort: () => number;
    readonly mintToken: () => string;
    readonly now: () => number;
    /** Established connections to the port, or `null` when the OS would not say. */
    readonly connections: (port: number) => Promise<number | null>;
    readonly idleMs: number;
    /** Whether a pid still runs. Absent = a stop is not verified. */
    readonly pidAlive?: (pid: number) => boolean;
    /** Ends a pid and everything it started, by the process tree rules (end-child-trees.ts), never `taskkill /T`. */
    readonly forceEnd?: (pid: number) => Promise<void>;
    readonly sleep?: (ms: number) => Promise<void>;
    /** How long a stopped server may take to exit before it is forced; absent = 5000. */
    readonly forceAfterMs?: number;
}

export interface RunningPlaywrightServer {
    readonly port: number;
    readonly token: string;
    readonly version: string;
}

export class PlaywrightServer {
    readonly #ports: PlaywrightServerPorts;
    #current: (RunningPlaywrightServer & { lastActiveAt: number }) | null = null;

    constructor(ports: PlaywrightServerPorts) {
        this.#ports = ports;
    }

    /** The running server for this version: started when none is, replaced when it is another version's. */
    acquire(version: string): RunningPlaywrightServer {
        const now = this.#ports.now();
        const cur = this.#live();
        if (cur && cur.version === version) {
            cur.lastActiveAt = now;
            return { port: cur.port, token: cur.token, version: cur.version };
        }
        if (cur) void this.stop();
        const port = this.#ports.allocatePort();
        const token = this.#ports.mintToken();
        const { command } = serverCommand({ cliDir: this.#ports.cliDir(version), host: SERVER_HOST, port, token });
        this.#ports.supervisor.start({ id: PLAYWRIGHT_SERVER_PROCESS_ID, workspaceId: this.#ports.workspaceId, name: 'Playwright server', command, cwd: this.#ports.cwd, restart: 'never' });
        this.#current = { port, token, version, lastActiveAt: now };
        return { port, token, version };
    }

    /** One look: stops the server when it has been idle for the window. `off` when none runs. */
    async sweep(): Promise<'stopped' | 'kept' | 'off'> {
        const cur = this.#live();
        if (!cur) return 'off';
        const now = this.#ports.now();
        const connections = await this.#ports.connections(cur.port);
        if (connections !== null && connections > 0) cur.lastActiveAt = now;
        if (decideIdle({ lastActiveAt: cur.lastActiveAt, now, idleMs: this.#ports.idleMs, connections }) === 'stop') {
            void this.stop();
            return 'stopped';
        }
        return 'kept';
    }

    /**
     * Stop it, and see that it ENDED. The supervisor's stop closes the server's pty, whose helper's job object takes the tree
     * with it (spawn-host-client.ts); that is asked, not assumed: a process still there after the grace is ended with everything
     * it started, by the process tree's rules (`forceEnd`). Never hangs: a forced end that does not return, or fails, is given up
     * on after the same grace. The supervisor's stop happens before this returns, so callers need not wait.
     */
    stop(): Promise<'ended' | 'forced'> {
        if (!this.#current) return Promise.resolve('ended');
        const pid = this.#ports.supervisor.status(PLAYWRIGHT_SERVER_PROCESS_ID)?.pid ?? null;
        this.#ports.supervisor.stop(PLAYWRIGHT_SERVER_PROCESS_ID);
        this.#current = null;
        return this.#verifyEnded(pid);
    }

    async #verifyEnded(pid: number | null): Promise<'ended' | 'forced'> {
        const { pidAlive, forceEnd } = this.#ports;
        if (pid === null || !pidAlive) return 'ended';
        const grace = this.#ports.forceAfterMs ?? 5_000;
        const sleep = this.#ports.sleep ?? ((ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); }));
        for (let waited = 0; waited < grace; waited += POLL_MS) {
            if (!pidAlive(pid)) return 'ended';
            await sleep(POLL_MS);
        }
        if (!pidAlive(pid)) return 'ended';
        if (forceEnd) {
            try {
                await Promise.race([forceEnd(pid), sleep(grace)]);
            } catch {
                // it could not be ended here either: the stop is reported forced, and the process list still shows it
            }
        }
        return 'forced';
    }

    running(): RunningPlaywrightServer | null {
        const cur = this.#live();
        return cur ? { port: cur.port, token: cur.token, version: cur.version } : null;
    }

    /** Running means the supervisor says so: a server that died on its own is forgotten, never handed out. */
    #live(): (RunningPlaywrightServer & { lastActiveAt: number }) | null {
        if (!this.#current) return null;
        const status = this.#ports.supervisor.status(PLAYWRIGHT_SERVER_PROCESS_ID);
        if (status?.state !== 'running') {
            this.#current = null;
            return null;
        }
        return this.#current;
    }
}
