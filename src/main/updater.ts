import { orphanReport, orphansUnder, updaterChannel, type RunningProcess } from './upgrade.js';

/**
 * THE UPDATE HOST — §7, wired.
 *
 * `upgrade.ts` carries the channel settings and the orphan scan; until this file nothing CALLED
 * the library, so "check for updates" could not run — the §0.8 failure in a new coat
 * (configured, tested, inert). This host is the one place `electron-updater` is driven from,
 * behind `UpdaterPort` so `test/updater.test.ts` proves every rule without a feed.
 *
 * ## The rules, in one place
 *
 * - A check reports `available <version>` or `none`. **Nothing downloads by itself**
 *   (`autoDownload: false` reaches the library, and this host never calls `download` for you).
 * - A check while one is in flight is REJOINED — one library call, one answer, every caller.
 * - `download()` before `available` and `install()` before `downloaded` are refused as RETURN
 *   VALUES (`false` / `null`), never as silent no-ops: a UI that asked gets told.
 * - §7.2: `install()` first terminates every process running from the install directory —
 *   only those (`orphansUnder`: never our own pid, never a sibling install) — and returns the
 *   report naming them, then hands over to the library's `quitAndInstall`.
 * - An error is a phase with the library's message; the next check clears it.
 *
 * ## The state is honest (§5)
 *
 * `version`, `percent`, `checkedAt` and `error` are `null` until known. `idle` means "never
 * checked"; `none` means "checked, and there is nothing" — different claims, different phases.
 */

export type UpdatePhase =
    | 'idle'
    | 'checking'
    | 'none'
    | 'available'
    | 'downloading'
    | 'downloaded'
    | 'installing'
    | 'error';

export interface UpdateState {
    phase: UpdatePhase;
    /** The version on offer, from `available` onwards. */
    version: string | null;
    /** Download progress 0–100 while downloading; 100 once downloaded. */
    percent: number | null;
    /** The library's message, in the `error` phase only. */
    error: string | null;
    /** When the last check ANSWERED (not when it started). */
    checkedAt: number | null;
}

/** The seam to `electron-updater`. `electron-updater-port.ts` is the only real implementation. */
export interface UpdaterPort {
    /** Called exactly once, before anything else, with the channel pair from `upgrade.ts`. */
    configure(channel: { allowPrerelease: boolean; autoDownload: boolean }): void;
    /** Resolves the offered version, or `null` when there is none. Rejects on a library error. */
    check(): Promise<{ version: string } | null>;
    /** Downloads the update found by the last check, reporting progress 0–100. */
    download(onProgress: (percent: number) => void): Promise<void>;
    /** Quits and runs the installer. Does not return in the real implementation. */
    quitAndInstall(): void;
}

export interface UpdateHostOptions {
    port: UpdaterPort;
    /** Where the running app is installed; what §7.2's teardown scans for. */
    installDir: string;
    ownPid: number;
    /** Every process the OS can describe, when asked. */
    processes: () => readonly RunningProcess[];
    /** Terminate one process; `false` when it could not be. */
    kill: (pid: number) => boolean;
    clock?: () => number;
    /** Windows paths compare case-insensitively; defaults to the platform's rule. */
    caseInsensitive?: boolean;
    /** Runs `fn` after `ms`; `setTimeout` unless a test wants to hold the quit in its hand. */
    defer?: (fn: () => void, ms: number) => void;
}

/**
 * How long `install()` holds the quit after answering.
 *
 * Long enough for the IPC reply carrying the §7.2 report to reach the renderer and for the
 * renderer to paint "installing" — measured: with the quit in the same tick, the reply never
 * arrived and the page was gone before it could (Windows VM, 2026-10-10). Short enough that
 * nobody sees a pause after pressing "restart to install".
 */
export const QUIT_DELAY_MS = 250;

export interface InstallResult {
    killed: readonly RunningProcess[];
    /** `orphanReport` — names every process that had to be stopped, or says none were. */
    report: string;
}

const IDLE: UpdateState = { phase: 'idle', version: null, percent: null, error: null, checkedAt: null };

export class UpdateHost {
    private current: UpdateState = IDLE;
    private inFlight: Promise<UpdateState> | null = null;
    private readonly listeners = new Set<(state: UpdateState) => void>();
    private readonly clock: () => number;

    constructor(private readonly options: UpdateHostOptions) {
        this.clock = options.clock ?? Date.now;
        options.port.configure({
            allowPrerelease: updaterChannel.allowPrerelease,
            autoDownload: updaterChannel.autoDownload,
        });
    }

    state(): UpdateState {
        return this.current;
    }

    onChange(listener: (state: UpdateState) => void): () => void {
        this.listeners.add(listener);
        return () => { this.listeners.delete(listener); };
    }

    /** Ask the feed. Rejoins a check already in flight. Resolves to the resulting state. */
    check(): Promise<UpdateState> {
        if (this.inFlight) return this.inFlight;
        this.set({ phase: 'checking', version: null, percent: null, error: null, checkedAt: this.current.checkedAt });
        this.inFlight = this.options.port.check().then(
            (found) => {
                const checkedAt = this.clock();
                if (found) this.set({ phase: 'available', version: found.version, percent: null, error: null, checkedAt });
                else this.set({ phase: 'none', version: null, percent: null, error: null, checkedAt });
                return this.current;
            },
            (error: unknown) => {
                const message = error instanceof Error ? error.message : String(error);
                this.set({ phase: 'error', version: null, percent: null, error: message, checkedAt: this.clock() });
                return this.current;
            },
        ).finally(() => { this.inFlight = null; });
        return this.inFlight;
    }

    /** Download what the last check found. `false` when there is nothing to download. */
    async download(): Promise<boolean> {
        if (this.current.phase !== 'available') return false;
        const version = this.current.version;
        this.set({ ...this.current, phase: 'downloading', percent: 0 });
        try {
            await this.options.port.download((percent) => {
                if (this.current.phase === 'downloading') this.set({ ...this.current, percent });
            });
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
            this.set({ ...this.current, phase: 'error', error: message });
            return false;
        }
        this.set({ phase: 'downloaded', version, percent: 100, error: null, checkedAt: this.current.checkedAt });
        return true;
    }

    /**
     * §7.2 then install. `null` when nothing is downloaded. Otherwise every process running
     * from the install directory is terminated FIRST, the report is returned to the caller
     * (who shows it), and the library is told to quit and install — `QUIT_DELAY_MS` later, so
     * the answer leaves the process before the process leaves.
     */
    install(): InstallResult | null {
        if (this.current.phase !== 'downloaded') return null;
        const orphans = orphansUnder(
            this.options.processes(),
            this.options.installDir,
            this.options.ownPid,
            this.options.caseInsensitive,
        );
        for (const p of orphans) this.options.kill(p.pid);
        this.set({ ...this.current, phase: 'installing' });
        (this.options.defer ?? ((fn, ms) => { setTimeout(fn, ms); }))(() => this.options.port.quitAndInstall(), QUIT_DELAY_MS);
        return { killed: orphans, report: orphanReport(orphans) };
    }

    private set(next: UpdateState): void {
        this.current = next;
        for (const l of this.listeners) l(next);
    }
}
