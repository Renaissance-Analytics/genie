import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
    ALIVE_FILE, ALIVE_PREV_FILE, CLEAN_EXIT_FILE, NOT_SAFE, SAFE_MODE_FILE, UNKNOWN_CAUSE,
    bootDecision, parseAlive, parseCleanExit, parseRecord,
    type SafeModeItem, type SafeModeRecord, type SafeModeView,
} from '../core/safe-mode.js';

/**
 * SAFE MODE, GENIE-HOST'S (Tynn #386; core/safe-mode.ts has the rules). Opened ONCE by the host at its boot, right after
 * it holds the endpoint (a second host that exits never touches the marker): the marker is read and removed, the record
 * written, and from then on every automatic start in the host asks `active()` — the mail wake and IssueWatch's push, the
 * flows' clocks, the scheduled tasks, the process book's restore, the sites, the engines — and the window's boot restore
 * asks it over the engine link. Leaving re-arms the clocks (the host's listener) and starts nothing.
 *
 * Every write is small and synchronous: at boot before anything starts, at the end as the very last step, and the beat.
 */
export class SafeMode {
    readonly #dir: string;
    readonly #now: () => number;
    readonly #pid: number;
    readonly #log: (line: string) => void;
    #record: SafeModeRecord;
    #view: SafeModeView;
    readonly #listeners = new Set<(view: SafeModeView) => void>();

    private constructor(dir: string, now: () => number, pid: number, log: (line: string) => void, record: SafeModeRecord, view: SafeModeView) {
        this.#dir = dir;
        this.#now = now;
        this.#pid = pid;
        this.#log = log;
        this.#record = record;
        this.#view = view;
    }

    static open(runtimeDir: string, options: { readonly now?: () => number; readonly pid?: number; readonly log?: (line: string) => void; readonly cause?: () => string; readonly asyncBeat?: boolean } = {}): SafeMode {
        const now = options.now ?? Date.now;
        const log = options.log ?? (() => {});
        mkdirSync(runtimeDir, { recursive: true });
        const read = (name: string): string | null => { try { return readFileSync(join(runtimeDir, name), 'utf8'); } catch { return null; } };
        const cleanExit = parseCleanExit(read(CLEAN_EXIT_FILE));
        const decision = bootDecision({
            cleanExit,
            record: parseRecord(read(SAFE_MODE_FILE)),
            alive: parseAlive(read(ALIVE_FILE)) ?? parseAlive(read(ALIVE_PREV_FILE)),
            now: now(),
        });
        // REMOVED AT BOOT: from here on, only this run's own clean end can write it again.
        rmSync(join(runtimeDir, CLEAN_EXIT_FILE), { force: true });
        // THE CAUSE (cut 3: crash-records.ts `previousRunCause`), read only for a run that did not end cleanly: a kept crash
        // loop after a clean end has no record of its own to read. Never fatal: an unreadable cause is the unknown one.
        let cause = UNKNOWN_CAUSE;
        if (decision.active && cleanExit === null && options.cause) { try { cause = options.cause(); } catch { cause = UNKNOWN_CAUSE; } }
        const view: SafeModeView = decision.active
            ? { active: true, at: decision.at, cause, crashLoop: decision.crashLoop, agents: [...decision.agents], processes: [], sites: [] }
            : NOT_SAFE;
        const mode = new SafeMode(runtimeDir, now, options.pid ?? process.pid, log, decision.record, view);
        mode.#writeRecord();
        if (view.active) log(`safe mode: the last run did not end cleanly${decision.crashLoop ? ' (a crash loop: kept until the person leaves it)' : ''}; nothing starts by itself`);
        return mode;
    }

    active(): boolean {
        return this.#view.active;
    }

    view(): SafeModeView {
        return this.#view;
    }

    /** "Leave safe mode": automatic behaviour is back; nothing is started here. Kept on disk, so a crash loop ends too. */
    leave(): SafeModeView {
        if (!this.#view.active) return this.#view;
        this.#record = { ...this.#record, kept: false };
        this.#writeRecord();
        this.#view = NOT_SAFE;
        this.#log('safe mode: left by the person; automatic starts are back on');
        this.#emit();
        return this.#view;
    }

    onChange(listener: (view: SafeModeView) => void): () => void {
        this.#listeners.add(listener);
        return () => { this.#listeners.delete(listener); };
    }

    /** A kept process or a site this start held down: listed on the banner with its own Start. */
    hold(kind: 'process' | 'site', item: SafeModeItem): void {
        if (!this.#view.active) return;
        const list = kind === 'process' ? this.#view.processes : this.#view.sites;
        if (list.some((x) => x.id === item.id)) return;
        this.#view = kind === 'process' ? { ...this.#view, processes: [...list, item] } : { ...this.#view, sites: [...list, item] };
        this.#emit();
    }

    /** The agents a quit or an upgrade recorded (kept, not acted on): added to those the last beat saw running. */
    wasRunning(agents: readonly string[]): void {
        if (!this.#view.active) return;
        const more = agents.filter((a) => !this.#view.agents.includes(a));
        if (more.length === 0) return;
        this.#view = { ...this.#view, agents: [...this.#view.agents, ...more] };
        this.#emit();
    }

    /**
     * The host's sign of life: when, and which agents have a session. What the next start reads if this run dies. The one
     * before it is kept beside it (written first, atomically too), so a kill that cuts this write leaves a good one to read.
     */
    beat(agents: readonly string[]): void {
        const now = { at: this.#now(), pid: this.#pid, agents: [...agents] };
        if (this.#lastAlive !== null) this.#writeAtomic(ALIVE_PREV_FILE, this.#lastAlive);
        this.#writeAtomic(ALIVE_FILE, now);
        this.#lastAlive = now;
    }
    #lastAlive: { at: number; pid: number; agents: string[] } | null = null;

    /** Resolves once every beat so far is written. */
    flush(): Promise<void> { return Promise.resolve(); }

    /** The LAST step of the host's own end. Synchronous: the process exits right after it. */
    writeCleanExit(reason: string): void {
        try {
            writeFileSync(join(this.#dir, CLEAN_EXIT_FILE), JSON.stringify({ at: this.#now(), reason, pid: this.#pid }), 'utf8');
        } catch (error) {
            this.#log(`safe mode: the clean-exit marker could not be written: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    #writeRecord(): void {
        this.#writeAtomic(SAFE_MODE_FILE, this.#record);
    }

    #writeAtomic(name: string, value: unknown): void {
        const file = join(this.#dir, name);
        const temp = `${file}.${this.#pid}.tmp`;
        try {
            writeFileSync(temp, JSON.stringify(value), 'utf8');
            renameSync(temp, file);
        } catch (error) {
            rmSync(temp, { force: true });
            this.#log(`safe mode: ${name} could not be written: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    #emit(): void {
        for (const listener of [...this.#listeners]) {
            try { listener(this.#view); } catch { /* a listener's fault is its own */ }
        }
    }
}
