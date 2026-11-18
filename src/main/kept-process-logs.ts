import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { joinLogs, type ProcessLog } from '../core/output-tail.js';
import type { ProcessStatus } from './process-supervisor.js';
import { readJson, writeJsonAtomic } from './store.js';

/**
 * A KEPT PROCESS'S OUTPUT, KEPT PAST GENIE ITSELF (Tynn #860; the owner, 2026-11-18: "anything that executes tasks needs to
 * provide a log I can read").
 *
 * The supervisor's tail (core/output-tail.ts) outlives a run but not the Genie that ran it: after a restart a process
 * "stopped by restart (restart: never)" had nothing to show for the run that came before. This keeps, for each process the
 * book keeps (`owns`), its tail on disk under the runtime folder (`process-logs/<id>.json`), and reads it back JOINED with
 * what the process printed since (core/output-tail.ts `joinLogs`): the earlier output, Genie's own line where this Genie
 * took over, then this run. Bounded as the supervisor's tail is, every cut counted.
 *
 * A site's server, worker or the front door is never written here: those are the supervisor's alone (`owns` is false).
 * Writes follow output after a short pause, and a status change (an exit, a crash) at once; `flush` writes what is
 * pending (a shutdown, a test). `forget` removes the file with the process.
 */

export interface KeptProcessLogsDeps {
    readonly supervisor: {
        readLog(id: string, lines?: number): ProcessLog | null;
        onOutput(listener: (id: string, data: string) => void): () => void;
        onChange(listener: (status: ProcessStatus) => void): () => void;
    };
    /** Whether the book keeps this process: only those are written. */
    readonly owns: (id: string) => boolean;
    /** The clock for the write after output; a timer by default. */
    readonly schedule?: (fn: () => void, ms: number) => () => void;
}

/** How long after output its write waits, so a chatty process is written about once a second, not per line. */
export const OUTPUT_WRITE_DELAY_MS = 1_000;

/** STUB (Tynn #860 review RED). */
export const KEPT_LOG_MAX_BYTES = 256_000;

interface KeptFile {
    readonly text: string;
    readonly lines: number;
    readonly dropped: number;
    readonly at: number;
}

const fileName = (id: string) => `${encodeURIComponent(id)}.json`;

function timer(fn: () => void, ms: number): () => void {
    const t = setTimeout(fn, ms);
    (t as { unref?: () => void }).unref?.();
    return () => clearTimeout(t);
}

export class KeptProcessLogs {
    readonly #dir: string;
    readonly #deps: KeptProcessLogsDeps;
    /** What earlier Genies kept, per process: read once, when this one opened. */
    readonly #earlier: Map<string, ProcessLog>;
    readonly #pending = new Map<string, () => void>();
    readonly #writes = new Set<Promise<void>>();

    private constructor(dir: string, deps: KeptProcessLogsDeps, earlier: Map<string, ProcessLog>) {
        this.#dir = dir;
        this.#deps = deps;
        this.#earlier = earlier;
        deps.supervisor.onOutput((id) => this.#touch(id, OUTPUT_WRITE_DELAY_MS));
        deps.supervisor.onChange((s) => this.#touch(s.id, 0));
    }

    static async open(dir: string, deps: KeptProcessLogsDeps): Promise<KeptProcessLogs> {
        const earlier = new Map<string, ProcessLog>();
        let names: string[] = [];
        try { names = await readdir(dir); } catch { /* none kept yet */ }
        for (const name of names) {
            if (!name.endsWith('.json')) continue;
            const kept = await readJson<Partial<KeptFile> | null>(join(dir, name), null);
            if (!kept || typeof kept.text !== 'string') continue;
            let id: string;
            try { id = decodeURIComponent(name.slice(0, -'.json'.length)); } catch { continue; }
            earlier.set(id, { text: kept.text, lines: typeof kept.lines === 'number' ? kept.lines : kept.text.split('\n').length, dropped: typeof kept.dropped === 'number' ? kept.dropped : 0 });
        }
        return new KeptProcessLogs(dir, deps, earlier);
    }

    /** The process's output: earlier Genies' then this one's; the last `lines` (all kept when absent); null = none at all. */
    read(id: string, lines?: number): ProcessLog | null {
        return joinLogs(this.#earlier.get(id) ?? null, this.#deps.supervisor.readLog(id) ?? null, lines);
    }

    /** Write every pending process now, and wait for every write. */
    async flush(): Promise<void> {
        for (const [id, cancel] of [...this.#pending]) {
            cancel();
            this.#pending.delete(id);
            this.#write(id);
        }
        await Promise.all([...this.#writes]);
    }

    /** The process is gone (removed): its kept output goes with it. */
    async forget(id: string): Promise<void> {
        this.#pending.get(id)?.();
        this.#pending.delete(id);
        this.#earlier.delete(id);
        await Promise.all([...this.#writes]);
        await rm(join(this.#dir, fileName(id)), { force: true });
    }

    #touch(id: string, ms: number): void {
        if (!this.#deps.owns(id)) return;
        const pending = this.#pending.get(id);
        if (pending) {
            if (ms > 0) return; // already due soon
            pending(); // a status change writes now
            this.#pending.delete(id);
        }
        const schedule = this.#deps.schedule ?? timer;
        let ran = false;
        const cancel = schedule(() => { ran = true; this.#pending.delete(id); this.#write(id); }, ms);
        if (!ran) this.#pending.set(id, cancel);
    }

    #write(id: string): void {
        if (!this.#deps.owns(id)) return;
        const log = this.read(id);
        if (!log) return;
        const kept: KeptFile = { text: log.text, lines: log.lines, dropped: log.dropped, at: Date.now() };
        const write: Promise<void> = writeJsonAtomic(join(this.#dir, fileName(id)), kept)
            .catch((error: unknown) => { console.error(`[genie] could not keep the log of process ${id}: ${error instanceof Error ? error.message : String(error)}`); })
            .finally(() => { this.#writes.delete(write); });
        this.#writes.add(write);
    }
}
