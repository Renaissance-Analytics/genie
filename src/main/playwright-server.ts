import type { SupervisorApi } from './process-supervisor.js';

/** INERT STUB (Tynn #604 RED): signatures only, no behaviour. */
export interface PlaywrightServerPorts {
    readonly supervisor: Pick<SupervisorApi, 'start' | 'stop' | 'status'>;
    readonly workspaceId: string;
    readonly cwd: string;
    readonly cliDir: (version: string) => string;
    readonly allocatePort: () => number;
    readonly mintToken: () => string;
    readonly now: () => number;
    readonly connections: (port: number) => Promise<number | null>;
    readonly idleMs: number;
}

export class PlaywrightServer {
    constructor(_ports: PlaywrightServerPorts) {}
    async acquire(_version: string): Promise<{ port: number; token: string; version: string }> {
        return { port: 0, token: '', version: '' };
    }
    async sweep(): Promise<'stopped' | 'kept' | 'off'> {
        return 'kept';
    }
    stop(): void {}
    running(): { port: number; token: string; version: string } | null {
        return null;
    }
}
