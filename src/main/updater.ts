import { orphanReport, orphansUnder, type RunningProcess } from './upgrade.js';
import { changelogBetween, type ReleaseLike, type UpdateChangelog } from '../core/update-notes.js';
import { DEFAULT_UPDATE_CHANNEL, updaterConfigFor, type UpdateChannel } from '../core/update-channel.js';

/**
 * THE UPDATE HOST — §7, wired.
 *
 * `update-channel.ts` carries the channel settings and `upgrade.ts` the orphan scan; until this file nothing CALLED
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
    /**
     * What is in the update (Genie 1's upgrade window): every version after the running one up to the offered one, with
     * its "What's new" — from GitHub's releases (core/update-notes.ts). `null` = still fetching; `'unavailable'` = could
     * not be fetched (offline); absent = not asked (no releases source).
     */
    changelog?: UpdateChangelog | 'unavailable' | null;
}

/** The seam to `electron-updater`. `electron-updater-port.ts` is the only real implementation. */
export interface UpdaterPort {
    /**
     * Called once before anything else with `updaterConfigFor(channel)`, and again only when the
     * update channel CHANGES (`UpdateHost.setChannel`). Each call replaces the last.
     */
    configure(channel: { allowPrerelease: boolean; autoDownload: boolean }): void;
    /** Resolves the offered version, or `null` when there is none. Rejects on a library error. */
    check(): Promise<{ version: string } | null>;
    /** Downloads the update found by the last check, reporting progress 0–100. */
    download(onProgress: (percent: number) => void): Promise<void>;
    /** Quits and runs the installer. Does not return in the real implementation. */
    quitAndInstall(): void;
}

/**
 * The live agents at an upgrade: who is running, and the end of every session (§7.4). No agent is ASKED for anything
 * (the owner, 2026-10-12: "agents no longer need to write a handoff when genie upgrades") — an agent is a session that
 * resumes its own thread.
 */
export interface DrainAgentsPort {
    live(): ReadonlyArray<{ id: string; name: string }>;
    stopAll(): void;
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
    /** The live agents whose sessions end with the upgrade; absent = a test of the teardown alone. */
    agents?: DrainAgentsPort;
    /** The update channel at construction; `DEFAULT_UPDATE_CHANNEL` (dev) when absent. `setChannel` changes it later. */
    channel?: UpdateChannel;
    /** The version running now — where "what is in this update" starts. */
    runningVersion?: string;
    /** Genie's published releases (GitHub's releases API); absent = no changelog is fetched. */
    releases?: () => Promise<readonly ReleaseLike[]>;
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

/**
 * When Genie checks BY ITSELF: once shortly after boot, then every half hour. v1 checked at
 * boot and opened the sheet; 2.0.0-beta.5 never checked unless a script or a remote call asked,
 * so an installed Genie 2 could not learn that the next build existed (genie2#91). The interval
 * was four hours until the owner (2026-10-13): "it should not be every 4 hours, that is too
 * long." A check is one small feed read, so thirty minutes costs nothing. Nothing downloads by
 * itself — the check only moves the state to `available`, which the header's update chip shows;
 * downloading and installing stay the user's two clicks.
 */
export const AUTO_CHECK = { initialMs: 10_000, intervalMs: 30 * 60 * 1000 } as const;

export class UpdateHost {
    private current: UpdateState = IDLE;
    private inFlight: Promise<UpdateState> | null = null;
    private readonly listeners = new Set<(state: UpdateState) => void>();
    private readonly clock: () => number;
    private last: InstallResult | null = null;
    private currentChannel: UpdateChannel;

    constructor(private readonly options: UpdateHostOptions) {
        this.clock = options.clock ?? Date.now;
        this.currentChannel = options.channel ?? DEFAULT_UPDATE_CHANNEL;
        options.port.configure(updaterConfigFor(this.currentChannel));
    }

    /** The channel the library was last told. */
    channel(): UpdateChannel {
        return this.currentChannel;
    }

    /**
     * Follow the `update_channel` setting (the owner, 2026-10-12: "stable and dev update channels").
     * Re-configures the library only on a CHANGE; the same channel again is a no-op. The next check
     * — automatic or asked for — sees the new channel's releases.
     */
    setChannel(channel: UpdateChannel): void {
        if (channel === this.currentChannel) return;
        this.currentChannel = channel;
        this.options.port.configure(updaterConfigFor(channel));
    }

    state(): UpdateState {
        return this.current;
    }

    /**
     * Arm the automatic checks: one after `initialMs`, then one every `intervalMs`, each only
     * when a check makes sense (idle, none, error or available — never while a download or an
     * install is in progress; while downloading or downloaded, the timer re-reads missing notes instead). Returns the stop; after it, a timer that still fires does nothing.
     * The scheduler is injected so a test can count the timers and fire them by hand.
     */
    startAutoCheck(schedule: (fn: () => void, ms: number) => () => void, timing: { initialMs: number; intervalMs: number } = AUTO_CHECK): () => void {
        let stopped = false;
        let cancel: (() => void) | null = null;
        const arm = (ms: number): void => {
            cancel = schedule(() => {
                cancel = null;
                if (stopped) return;
                const phase = this.current.phase;
                const canCheck = phase === 'idle' || phase === 'none' || phase === 'error' || phase === 'available';
                if (!canCheck) {
                    // A downloading or downloaded update is not re-checked (that would drop the download), but notes
                    // that were missing are read again (beta.38, 2026-10-22). `available` re-reads them through check().
                    if (phase === 'downloading' || phase === 'downloaded') void this.refreshNotes();
                    arm(timing.intervalMs);
                    return;
                }
                void this.check().catch(() => undefined).finally(() => { if (!stopped) arm(timing.intervalMs); });
            }, ms);
        };
        arm(timing.initialMs);
        return () => { stopped = true; cancel?.(); cancel = null; };
    }

    onChange(listener: (state: UpdateState) => void): () => void {
        this.listeners.add(listener);
        return () => { this.listeners.delete(listener); };
    }

    /** The release notes between the running version and `offered`; set on the state while `offered` is still on offer. */
    #fetchChangelog(offered: string): Promise<void> {
        const releases = this.options.releases;
        const running = this.options.runningVersion;
        if (!releases || !running) return Promise.resolve();
        return releases().then(
            (list) => changelogBetween(list, running, offered),
            () => 'unavailable' as const,
        ).then((changelog) => {
            if (this.current.version !== offered) return;
            // A failed re-read never wipes notes already shown; it only says "unavailable" when there was nothing.
            const held = this.current.changelog;
            if (changelog === 'unavailable' && held && held !== 'unavailable') return;
            this.set({ ...this.current, changelog });
        });
    }

    #notesInFlight: Promise<UpdateState> | null = null;

    /**
     * READ THE NOTES AGAIN (the owner, 2026-10-22, on beta.38: "No release notes were published for this update"). The
     * notes are fetched once when a check finds an update; a release that was public before its body was written, or a
     * machine that was offline at that moment, kept the empty answer for as long as the update was on offer. This fetches
     * again — the update window calls it when it opens, the auto-check while an update is downloading or downloaded —
     * whenever what is held is not the whole story: none, unavailable or partial. A complete changelog is not fetched
     * again, and nothing is fetched when no update is on offer. Concurrent calls share one fetch.
     */
    refreshNotes(): Promise<UpdateState> {
        const { phase, version, changelog } = this.current;
        const onOffer = phase === 'available' || phase === 'downloading' || phase === 'downloaded';
        if (!onOffer || !version || !this.options.releases || !this.options.runningVersion) return Promise.resolve(this.current);
        const complete = changelog && changelog !== 'unavailable' && changelog.groups.length > 0 && !changelog.partial;
        if (complete) return Promise.resolve(this.current);
        if (this.#notesInFlight) return this.#notesInFlight;
        this.#notesInFlight = this.#fetchChangelog(version).then(() => this.current).finally(() => { this.#notesInFlight = null; });
        return this.#notesInFlight;
    }

    /** Ask the feed. Rejoins a check already in flight. Resolves to the resulting state. */
    check(): Promise<UpdateState> {
        if (this.inFlight) return this.inFlight;
        this.set({ phase: 'checking', version: null, percent: null, error: null, checkedAt: this.current.checkedAt });
        this.inFlight = this.options.port.check().then(
            (found) => {
                const checkedAt = this.clock();
                if (found) {
                    const fetching = this.options.releases && this.options.runningVersion ? { changelog: null } : {};
                    this.set({ phase: 'available', version: found.version, percent: null, error: null, checkedAt, ...fetching });
                    if ('changelog' in fetching) void this.#fetchChangelog(found.version);
                }
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
        this.set({ phase: 'downloaded', version, percent: 100, error: null, checkedAt: this.current.checkedAt, ...(this.current.changelog !== undefined ? { changelog: this.current.changelog } : {}) });
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
        // No agent is asked for a handoff (the owner): the sessions end, and each resumes its own thread when started.
        return this.finishInstall(this.options.agents?.live() ?? []);
    }

    /** The report of the install that ran last (the drain's words first, then §7.2's), for the UI that missed the return value. */
    lastInstall(): InstallResult | null {
        return this.last;
    }

    private finishInstall(live: ReadonlyArray<{ id: string; name: string }>): InstallResult {
        // §7.4: an upgrade ends every agent session and does not revive them.
        this.options.agents?.stopAll();
        const orphans = orphansUnder(
            this.options.processes(),
            this.options.installDir,
            this.options.ownPid,
            this.options.caseInsensitive,
        );
        for (const p of orphans) this.options.kill(p.pid);
        this.set({ ...this.current, phase: 'installing' });
        (this.options.defer ?? ((fn, ms) => { setTimeout(fn, ms); }))(() => this.options.port.quitAndInstall(), QUIT_DELAY_MS);
        const result: InstallResult = { killed: orphans, report: this.options.agents ? `${endedReport(live)}. ${orphanReport(orphans)}` : orphanReport(orphans) };
        this.last = result;
        return result;
    }

    private set(next: UpdateState): void {
        this.current = next;
        for (const l of this.listeners) l(next);
    }
}

/** The sessions an upgrade ended, by name, and that each resumes its own thread; or that none were running. */
function endedReport(live: ReadonlyArray<{ id: string; name: string }>): string {
    if (live.length === 0) return 'no agents were running';
    return `Ended ${live.length} agent session${live.length === 1 ? '' : 's'} (${live.map((a) => a.name).join(', ')}); each resumes its own thread when started again`;
}
