import { BEAT_MS, UNKNOWN_HEADER, toMb, type CrashHeader, type CrashRecord, type WindowBeatPayload } from '../core/crash-record.js';

/**
 * WINDOW MAIN'S HEARTBEAT AND ITS LAST-KNOWN STATE (Tynn story #386; spec §1).
 *
 * THE HEARTBEAT: every {@link BEAT_MS} window main tells genie-host it is alive, with its pid and its own RSS — a
 * notification on the engine link, no reply. A main that hangs stops beating; genie-host's watchdog (hang-watchdog.ts)
 * records it and ends the process. `bye` says the quit ran to its end, so the host does not read the drop as lost.
 *
 * THE EXIT PATHS: the third crash on 2026-11-06 was a sudden death with no hang (a 26 s gap, no WER event, no dump), so
 * evidence must exist BEFORE the end. Every path window main can catch writes `{ kind: 'exit', reason, code, at, rssMb,
 * agents }` — the agents by NAME, an error by its TYPE, never a message: synchronously (an `exit` listener runs nothing
 * asynchronous) and never throwing (an exit path must not fail because its record could not be written):
 *  - `process` `exit` — with its code — unless the quit ran to its end with code 0;
 *  - `uncaughtException`, `unhandledRejection` — once each per run. core/main-errors.ts keeps the process running past
 *    them (no dialog, no exit), so this is the evidence written before an end they may lead to;
 *  - `render-process-gone`, `child-process-gone` (the GPU, a renderer) — once per type and reason; a child's
 *    `clean-exit` is not a crash;
 *  - `before-quit` — written as the shutdown begins, and TAKEN BACK when the quit runs to its end (`cleanQuit`): a quit
 *    that dies on the way leaves it.
 */
export type WindowBeat = WindowBeatPayload;

/** `process` and Electron's `app`: Node's own listener shape, so either is one. */
interface Emitter {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Node's EventEmitter listener type, as declared
    on(event: string, listener: (...args: any[]) => void): unknown;
}

export interface WindowCrashRecorderOptions {
    readonly now?: () => number;
    readonly pid: number;
    /** RSS in bytes (`process.memoryUsage.rss()`). */
    readonly rss: () => number;
    /** The running agents' names. */
    readonly agents: () => string[];
    /** Writes the record synchronously; answers its file, or `null`. */
    readonly write: (record: CrashRecord) => string | null;
    readonly remove: (file: string) => void;
    /** The common header (crash-records.ts `crashHeader`): this Genie's version, the host's build, OS and uptime. */
    readonly header: () => CrashHeader;
}

export class WindowCrashRecorder {
    readonly #o: WindowCrashRecorderOptions;
    readonly #once = new Set<string>();
    #beforeQuitFile: string | null = null;
    #beforeQuitDone = false;
    #clean = false;

    constructor(options: WindowCrashRecorderOptions) {
        this.#o = options;
    }

    install(proc: Emitter, app: Emitter): void {
        proc.on('exit', (code: number) => {
            if (this.#clean && code === 0) return;
            this.#record('exit', typeof code === 'number' ? code : null);
        });
        proc.on('uncaughtException', (error: unknown) => { this.#recordOnce('uncaught-exception', null, typeOf(error)); });
        proc.on('unhandledRejection', (reason: unknown) => { this.#recordOnce('unhandled-rejection', null, typeOf(reason)); });
        app.on('render-process-gone', (_event: unknown, _contents: unknown, details: { reason?: unknown; exitCode?: unknown }) => {
            this.#gone('render-process-gone', 'renderer', details);
        });
        app.on('child-process-gone', (_event: unknown, details: { type?: unknown; reason?: unknown; exitCode?: unknown }) => {
            this.#gone('child-process-gone', typeof details?.type === 'string' ? details.type : 'unknown', details);
        });
    }

    /** The shutdown begins: the last-known state, FIRST. Once. */
    beforeQuit(): void {
        if (this.#beforeQuitDone) return;
        this.#beforeQuitDone = true;
        this.#beforeQuitFile = this.#record('before-quit', null);
    }

    /** The quit ran to its end: its before-quit record is taken back, and a code-0 exit after it is not recorded. */
    cleanQuit(): void {
        this.#clean = true;
        const file = this.#beforeQuitFile;
        this.#beforeQuitFile = null;
        if (file !== null) { try { this.#o.remove(file); } catch { /* left: read as an unclean quit, the safe reading */ } }
    }

    #gone(event: string, type: string, details: { reason?: unknown; exitCode?: unknown } | undefined): void {
        const reason = typeof details?.reason === 'string' ? details.reason : 'unknown';
        if (reason === 'clean-exit') return;
        this.#recordOnce(`${event}:${type}:${reason}`, typeof details?.exitCode === 'number' ? details.exitCode : null);
    }

    #recordOnce(reason: string, code: number | null, error?: string): void {
        if (this.#once.has(reason)) return;
        this.#once.add(reason);
        this.#record(reason, code, error);
    }

    #record(reason: string, code: number | null, error?: string): string | null {
        try {
            let rssMb: number | null = null;
            try { rssMb = toMb(this.#o.rss()); } catch { /* unread */ }
            let agents: string[] = [];
            try { agents = this.#o.agents().map(String); } catch { /* unread */ }
            // The header never costs the record: a path where it cannot be read (main.ts's module not yet evaluated) says unknown.
            let header: CrashHeader = UNKNOWN_HEADER;
            try { header = this.#o.header(); } catch { /* unread */ }
            const record: CrashRecord = {
                ...header,
                kind: 'exit',
                at: new Date((this.#o.now ?? Date.now)()).toISOString(),
                pid: this.#o.pid,
                reason,
                code,
                rssMb,
                agents,
                ...(error !== undefined ? { error } : {}),
            };
            return this.#o.write(record);
        } catch {
            return null;
        }
    }
}

/** An error's TYPE only (`TypeError`): its message can carry what someone wrote. */
function typeOf(value: unknown): string {
    try {
        if (value instanceof Error) return value.constructor?.name || value.name || 'Error';
        return value === null ? 'null' : typeof value;
    } catch {
        return 'unknown';
    }
}

/**
 * Window main's beat: one at once (the host watches a window from its first beat), then every {@link BEAT_MS}. A send
 * that throws (no link) never escapes the timer. `bye` sends the goodbye and stops.
 */
export function startHeartbeat(options: { send(beat: WindowBeat): void; pid: number; rss: () => number; every?: (fn: () => void, ms: number) => () => void }): { stop(): void; bye(): void } {
    const beat = (bye: boolean): void => {
        try {
            const rss = options.rss();
            options.send(bye ? { pid: options.pid, rss, bye: true } : { pid: options.pid, rss });
        } catch { /* not linked: the next beat tries again */ }
    };
    const every = options.every ?? ((fn: () => void, ms: number) => {
        const timer = setInterval(fn, ms);
        timer.unref?.();
        return () => clearInterval(timer);
    });
    beat(false);
    let stop: (() => void) | null = every(() => beat(false), BEAT_MS);
    const halt = (): void => { stop?.(); stop = null; };
    return {
        stop: halt,
        bye: () => { halt(); beat(true); },
    };
}
