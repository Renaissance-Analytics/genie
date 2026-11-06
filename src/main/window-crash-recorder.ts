import type { CrashRecord, WindowBeatPayload } from '../core/crash-record.js';

/**
 * WINDOW MAIN'S HEARTBEAT AND LAST-KNOWN STATE (Tynn story #386). Not built yet: this is its shape.
 */
export type WindowBeat = WindowBeatPayload;

interface Emitter {
    on(event: string, listener: (...args: never[]) => void): unknown;
}

export interface WindowCrashRecorderOptions {
    readonly now?: () => number;
    readonly pid: number;
    /** RSS in bytes. */
    readonly rss: () => number;
    readonly agents: () => string[];
    readonly write: (record: CrashRecord) => string | null;
    readonly remove: (file: string) => void;
}

export class WindowCrashRecorder {
    constructor(_options: WindowCrashRecorderOptions) {}

    install(_proc: Emitter, _app: Emitter): void {}

    beforeQuit(): void {}

    cleanQuit(): void {}
}

export function startHeartbeat(_options: { send(beat: WindowBeat): void; pid: number; rss: () => number; every?: (fn: () => void, ms: number) => () => void }): { stop(): void; bye(): void } {
    return { stop: () => {}, bye: () => {} };
}
