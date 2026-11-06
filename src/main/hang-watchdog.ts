import type { CrashRecord, RssSample, RunningAgentNote } from '../core/crash-record.js';

/**
 * GENIE-HOST'S HANG WATCHDOG (Tynn story #386). Not built yet: this is its shape.
 */
export interface HangWatchdogOptions {
    readonly now?: () => number;
    /** The 1 s tick; answers its stop. Default `setInterval`, unref'd. */
    readonly every?: (fn: () => void, ms: number) => () => void;
    readonly write: (record: CrashRecord) => void;
    /** Ends a frozen window's process (taskkill /F on Windows, SIGKILL elsewhere): never a tree. */
    readonly kill: (pid: number) => Promise<unknown> | unknown;
    readonly alive: (pid: number) => boolean;
    /** This host's own RSS, in bytes. */
    readonly hostRss: () => number;
    readonly agents: () => RunningAgentNote[];
    readonly lifecycle: () => string[];
    readonly log: (line: string) => void;
}

export class HangWatchdog {
    constructor(_options: HangWatchdogOptions) {}

    start(): void {}

    stop(): void {}

    beat(_connId: string, _beat: unknown): void {}

    dropped(_connId: string): void {}

    shuttingDown(): void {}

    samples(): readonly RssSample[] {
        return [];
    }
}
