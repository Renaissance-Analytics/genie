import { HANG_MS, LOST_GRACE_MS, RELAUNCH_MAX, RELAUNCH_WINDOW_MS, RSS_EVERY_MS, UNKNOWN_HEADER, mainStalls, parseBeat, toMb, type CrashHeader, type CrashRecord, type RssSample, type RunningAgentNote } from '../core/crash-record.js';

/**
 * GENIE-HOST'S HANG WATCHDOG (Tynn story #386; spec `.ai/plans/genie-crash-safe-mode-reporting-spec.md` §1).
 *
 * Two of the owner's crashes on 2026-11-06 were window-main HANGS: lifecycle.log silent for about 4 minutes, then a new
 * boot — no shutdown line, no Windows event, no dump. A watchdog inside the frozen process cannot run, so it is here, in
 * the host that survives the window: window main beats over the engine link every second (`engine.heartbeat`, a
 * notification with its pid and its RSS), and this tracks the last beat per window CONNECTION.
 *
 *  - HANG: no beat for {@link HANG_MS} from a window that has beaten and is still connected → a `hang` record (the last
 *    lifecycle lines, main's stall lines from them, the memory samples, the running agents with their current turn's
 *    last tool name and size — no content), then the frozen process is ENDED (`kill`: taskkill /F on Windows, SIGKILL
 *    elsewhere; one pid, never a tree, so this host — and the agents it runs — survive). Once per connection.
 *  - RSS: every {@link RSS_EVERY_MS}, `rss window=<MB> host=<MB>` in lifecycle.log (the window's from its newest beat),
 *    so a sudden death — the third crash: a 26 s gap and nothing else — leaves the last reading behind.
 *  - LOST: a window connection that drops with no goodbye (`bye`, sent when its quit ran to its end) is checked after
 *    {@link LOST_GRACE_MS}: its process gone, and this host not ending itself (its own end writes the clean-exit marker),
 *    it is a `lost` record with its last beat and RSS. A window still alive only lost its link; it reconnects.
 *
 * A GAP IN THIS HOST'S OWN CLOCK (the machine asleep — the window slept too — or this host's loop held) PAUSES every
 * wait: the tick runs every second, so a tick that comes over 5 s late says the host was not running either, and that
 * stalled time comes off each window's silence. It used to restart the wait, and on a loaded machine (omarchy-test,
 * 2026-11-06: the host's loop 8–12 s late twice in every 40 s hold) a real hang was never reached. A window silent for
 * 30 s of the host's awake time is a hang; a sleep is one stalled span, so a window that beats after it is not. Each late
 * tick is logged with the CPU this host spent across it and its memory: busy (its own work) or not run at all.
 */

/** A tick this late says the host itself did not run (sleep, or its own loop held): nobody's silence is counted across it. */
const CLOCK_GAP_MS = 5_000;
const SAMPLES_KEPT = 60;

export interface HangWatchdogOptions {
    readonly now?: () => number;
    /** The 1 s tick; answers its stop. Default `setInterval`, unref'd: the watchdog never holds a host that is otherwise done. */
    readonly every?: (fn: () => void, ms: number) => () => void;
    readonly write: (record: CrashRecord) => void;
    /** Ends a frozen window's process (taskkill /F on Windows, SIGKILL elsewhere): one pid, never a tree. */
    readonly kill: (pid: number) => Promise<unknown> | unknown;
    readonly alive: (pid: number) => boolean;
    /** This host's own RSS, in bytes. */
    readonly hostRss: () => number;
    /** The running agents, each with its current turn's last tool name and size (core/crash-record.ts `runningAgentNote`). */
    readonly agents: () => RunningAgentNote[];
    /** This host's CPU time so far, in ms (`process.cpuUsage`): what a late tick is logged with. Absent = not said. */
    readonly cpuMs?: () => number;
    /** The last lifecycle lines (crash-records.ts `readLifecycleTail`). */
    readonly lifecycle: () => string[];
    readonly log: (line: string) => void;
    /** The common header (crash-records.ts `crashHeader`): this host's version, build, OS and uptime. */
    readonly header: () => CrashHeader;
    /** Starts a new window after a hung one was ended (genie-host: the installed Genie from the window's launch spec). Absent = none. */
    readonly relaunch?: () => void;
    /**
     * Resolves once an ended window's process and the sockets it held are gone, or `false` at its bound (genie-host:
     * window-release.ts). The new window is started after it either way. Absent = straight after the kill.
     */
    readonly released?: (pid: number) => Promise<boolean>;
    /** Each hang: when, how many within the window of {@link RELAUNCH_WINDOW_MS}, and whether a new window was started. */
    readonly onHang?: (hang: { at: number; hangs: number; relaunched: boolean }) => void;
    readonly hangMs?: number;
    readonly lostMs?: number;
    readonly rssEveryMs?: number;
}

interface Watched {
    pid: number;
    lastBeatAt: number;
    rss: number;
    bye: boolean;
    /** The watchdog ended it for a hang: recorded once, and never again as lost. */
    ended: boolean;
    droppedAt: number | null;
}

export class HangWatchdog {
    readonly #o: HangWatchdogOptions;
    readonly #now: () => number;
    readonly #windows = new Map<string, Watched>();
    readonly #samples: RssSample[] = [];
    #stop: (() => void) | null = null;
    #lastTick: number;
    #lastCpu: number | null = null;
    #lastRssAt: number;
    #newestRss: { at: number; rss: number; pageRss?: number } | null = null;
    #shuttingDown = false;
    /** When each recent hang was: the relaunch cap's window. */
    #hangTimes: number[] = [];

    constructor(options: HangWatchdogOptions) {
        this.#o = options;
        this.#now = options.now ?? Date.now;
        this.#lastTick = this.#now();
        this.#lastRssAt = this.#lastTick;
    }

    start(): void {
        if (this.#stop) return;
        this.#lastTick = this.#now();
        this.#lastRssAt = this.#lastTick;
        const every = this.#o.every ?? ((fn: () => void, ms: number) => {
            const timer = setInterval(fn, ms);
            timer.unref?.();
            return () => clearInterval(timer);
        });
        this.#stop = every(() => this.#tick(), 1_000);
    }

    stop(): void {
        this.#stop?.();
        this.#stop = null;
    }

    /** A window's beat (`engine.heartbeat`), by its connection. A frame that is not a beat is ignored. */
    beat(connId: string, value: unknown): void {
        const beat = parseBeat(value);
        if (beat === null) return;
        const now = this.#now();
        const known = this.#windows.get(connId);
        if (known) {
            known.pid = beat.pid;
            known.lastBeatAt = now;
            known.rss = beat.rss;
            if (beat.bye) known.bye = true;
        } else {
            this.#windows.set(connId, { pid: beat.pid, lastBeatAt: now, rss: beat.rss, bye: beat.bye === true, ended: false, droppedAt: null });
        }
        this.#newestRss = { at: now, rss: beat.rss, ...(beat.rendererRss !== undefined ? { pageRss: beat.rendererRss } : {}) };
    }

    /** A window's connection closed. Without a goodbye it is checked for a LOST window after the grace. */
    dropped(connId: string): void {
        const w = this.#windows.get(connId);
        if (!w) return;
        if (w.bye || w.ended || this.#shuttingDown) { this.#windows.delete(connId); return; }
        w.droppedAt = this.#now();
    }

    /** This host is ending (it writes the clean-exit marker last): no window that drops with it is lost, and none is ended. */
    shuttingDown(): void {
        this.#shuttingDown = true;
    }

    samples(): readonly RssSample[] {
        return this.#samples;
    }

    #tick(): void {
        try {
            const now = this.#now();
            const gap = now - this.#lastTick;
            this.#lastTick = now;
            const cpu = this.#safe(() => this.#o.cpuMs?.() ?? null, null);
            const cpuSpent = cpu !== null && this.#lastCpu !== null ? Math.round(cpu - this.#lastCpu) : null;
            this.#lastCpu = cpu;
            if (gap > CLOCK_GAP_MS) {
                // Only the stalled span comes off (the tick's own second is the window's): its wait pauses, never restarts.
                const stalled = gap - 1_000;
                for (const w of this.#windows.values()) {
                    w.lastBeatAt = Math.min(now, w.lastBeatAt + stalled);
                    if (w.droppedAt !== null) w.droppedAt = Math.min(now, w.droppedAt + stalled);
                }
                const rss = toMb(this.#safe(() => this.#o.hostRss(), 0));
                this.#o.log(`hang watchdog: this host's clock jumped ms=${gap} cpu_ms=${cpuSpent ?? '-'} host_rss_mb=${rss} (asleep, or its loop held); the window waits pause for it`);
            }
            if (now - this.#lastRssAt >= (this.#o.rssEveryMs ?? RSS_EVERY_MS)) {
                this.#lastRssAt = now;
                this.#sampleRss(now);
            }
            if (this.#shuttingDown) return;
            for (const [connId, w] of this.#windows) {
                if (w.droppedAt !== null) {
                    if (now - w.droppedAt >= (this.#o.lostMs ?? LOST_GRACE_MS)) {
                        this.#windows.delete(connId);
                        if (!this.#safe(() => this.#o.alive(w.pid), true)) this.#lost(w, now);
                    }
                    continue;
                }
                if (!w.ended && !w.bye && now - w.lastBeatAt >= (this.#o.hangMs ?? HANG_MS)) this.#hang(w, now);
            }
        } catch (error) {
            // The watchdog's own fault never takes the host down with it.
            try { this.#o.log(`hang watchdog: a tick failed: ${error instanceof Error ? error.message : String(error)}`); } catch { /* nothing left */ }
        }
    }

    #sampleRss(now: number): void {
        // The window's reading only while a window beats: a reading older than the sampling period is nobody's now.
        const windowMb = this.#newestRss !== null && now - this.#newestRss.at <= (this.#o.rssEveryMs ?? RSS_EVERY_MS) ? toMb(this.#newestRss.rss) : null;
        const hostMb = toMb(this.#safe(() => this.#o.hostRss(), 0));
        this.#samples.push({ at: new Date(now).toISOString(), windowMb, hostMb });
        if (this.#samples.length > SAMPLES_KEPT) this.#samples.splice(0, this.#samples.length - SAMPLES_KEPT);
        // The window's page beside it when the window sampled one (what grew before the owner's oom, 2026-11-06).
        const pageMb = windowMb !== null && this.#newestRss?.pageRss !== undefined ? toMb(this.#newestRss.pageRss) : null;
        this.#o.log(`rss window=${windowMb === null ? '-' : windowMb}${pageMb !== null ? ` page=${pageMb}` : ''} host=${hostMb}`);
    }

    #hang(w: Watched, now: number): void {
        w.ended = true;
        // THE CAP: a 4th hang within 10 minutes is recorded and NOT reopened — no relaunch loop.
        this.#hangTimes = [...this.#hangTimes.filter((t) => now - t < RELAUNCH_WINDOW_MS), now];
        const hangs = this.#hangTimes.length;
        const relaunch = this.#o.relaunch !== undefined && hangs <= RELAUNCH_MAX;
        const lifecycle = this.#safe(() => this.#o.lifecycle(), []);
        const record: CrashRecord = {
            ...this.#safe(() => this.#o.header(), UNKNOWN_HEADER),
            kind: 'hang',
            at: new Date(now).toISOString(),
            windowPid: w.pid,
            lastBeatAt: new Date(w.lastBeatAt).toISOString(),
            lifecycle,
            stalls: this.#safe(() => mainStalls(lifecycle), []),
            memory: [...this.#samples],
            agents: this.#safe(() => this.#o.agents(), []),
            relaunched: relaunch,
            hangsRecent: hangs,
        };
        this.#safe(() => this.#o.write(record), undefined);
        this.#o.log(`hang window pid=${w.pid} silent_ms=${now - w.lastBeatAt} hangs_10min=${hangs}: recorded, and the window is ended (this host and its agents keep running)${relaunch ? '; a new window is started' : this.#o.relaunch ? `; NOT reopened: ${hangs} hangs within 10 minutes` : ''}`);
        this.#safe(() => this.#o.onHang?.({ at: now, hangs, relaunched: relaunch }), undefined);
        // The new window only after the frozen one is ended: its single-instance lock is free by then. Ended or not, the
        // person is never left with Genie silently gone (the tray lives in the window's process).
        // And only once it has LET GO (Tynn #400; window-release.ts): its process and the sockets it held are gone, bounded.
        const reopen = (): void => { if (relaunch) this.#safe(() => this.#o.relaunch?.(), undefined); };
        const letGo = (): Promise<unknown> => {
            if (!relaunch || this.#o.released === undefined) return Promise.resolve(true);
            try { return Promise.resolve(this.#o.released(w.pid)); } catch { return Promise.resolve(false); }
        };
        let ending: Promise<unknown>;
        try { ending = Promise.resolve(this.#o.kill(w.pid)); } catch { ending = Promise.resolve(false); }
        void ending.then(letGo, letGo).then(reopen, reopen);
    }

    #lost(w: Watched, now: number): void {
        const record: CrashRecord = {
            ...this.#safe(() => this.#o.header(), UNKNOWN_HEADER),
            kind: 'lost',
            at: new Date(now).toISOString(),
            windowPid: w.pid,
            lastBeatAt: new Date(w.lastBeatAt).toISOString(),
            lastRssMb: toMb(w.rss),
            lifecycle: this.#safe(() => this.#o.lifecycle(), []),
            memory: [...this.#samples],
        };
        this.#safe(() => this.#o.write(record), undefined);
        this.#o.log(`lost window pid=${w.pid}: its link dropped with no goodbye and the process is gone`);
    }

    #safe<T>(fn: () => T, fallback: T): T {
        try { return fn(); } catch { return fallback; }
    }
}
