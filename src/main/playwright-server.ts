import type { SupervisorApi } from './process-supervisor.js';
import { SERVER_HOST, decideIdle, serverCommand } from '../core/playwright-managed.js';

/**
 * GENIE'S PLAYWRIGHT SERVER (Tynn #604): `playwright run-server` as a supervised process, on 127.0.0.1 with the token in its
 * path. Started on demand by the first agent that asks, one server at a time (one version), and stopped when nothing has been
 * connected to it for the idle window. The supervisor owns the process: its log is in Processes, and a stop here is a stop.
 */

export const PLAYWRIGHT_SERVER_PROCESS_ID = 'genie-playwright-server';

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
        if (cur) this.stop();
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
            this.stop();
            return 'stopped';
        }
        return 'kept';
    }

    stop(): void {
        if (!this.#current) return;
        this.#ports.supervisor.stop(PLAYWRIGHT_SERVER_PROCESS_ID);
        this.#current = null;
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
