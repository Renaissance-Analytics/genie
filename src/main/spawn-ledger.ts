import { readFileSync } from 'node:fs';
import type { ProcessInfo, ProcessTree } from '../core/process-tree.js';
import { leftoversToEnd, sweepLine, type LedgerRecord } from '../core/spawn-ledger.js';
import { writeJsonAtomic } from './store.js';

/**
 * THE SPAWN LEDGER'S FILE — `~/.genie/runtime/children.json` (hosting plan 1.5; the rules are core/spawn-ledger.ts).
 *
 * Read once, synchronously, at boot (a boot must sweep before it starts anything, and a missing or unreadable file is an
 * empty ledger, never a failed boot). Every change is written atomically, in order. A record leaves when its processes
 * are verified gone; a stop that left survivors keeps them recorded, so the next boot ends them.
 */
export class SpawnLedger {
    readonly #file: string;
    readonly #bootId: string;
    readonly #now: () => number;
    #records: LedgerRecord[];
    #writes: Promise<void> = Promise.resolve();

    private constructor(file: string, bootId: string, records: LedgerRecord[], now: () => number) {
        this.#file = file;
        this.#bootId = bootId;
        this.#records = records;
        this.#now = now;
    }

    static open(file: string, bootId: string, options: { now?: () => number } = {}): SpawnLedger {
        let records: LedgerRecord[] = [];
        try {
            const parsed = JSON.parse(readFileSync(file, 'utf8')) as { records?: unknown };
            if (Array.isArray(parsed.records)) records = parsed.records.filter(isRecord);
        } catch {
            // First run, or a file nobody can read: nothing recorded. The next write replaces it.
        }
        return new SpawnLedger(file, bootId, records, options.now ?? Date.now);
    }

    get size(): number {
        return this.#records.length;
    }

    /** A run's processes, as soon as they are known. Replaces that run's earlier record, if any. */
    record(entry: { kind: string; ownerId: string; run: number; processes: readonly ProcessInfo[] }): void {
        const rest = this.#records.filter((r) => !this.#same(r, entry));
        this.#records = [...rest, { ...entry, processes: [...entry.processes], bootId: this.#bootId, at: this.#now() }];
        this.#save();
    }

    /** A run verified ended: its record goes. */
    forget(kind: string, ownerId: string, run: number): void {
        const before = this.#records.length;
        this.#records = this.#records.filter((r) => !this.#same(r, { kind, ownerId, run }));
        if (this.#records.length !== before) this.#save();
    }

    /**
     * AT BOOT, before anything starts: end the tree of every previous boot's record still running as the same process,
     * log each, and drop the records it read. A machine that cannot be read ends nothing and keeps every record for the
     * next boot. Returns what it ended.
     */
    sweep(tree: ProcessTree, log: (line: string) => void): ProcessInfo[] {
        const previous = this.#records.filter((r) => r.bootId !== this.#bootId);
        if (previous.length === 0) return [];
        const table = tree.snapshot();
        if (table === null) {
            log(`sweep could not read the machine's processes; ${previous.length} record(s) kept for the next boot`);
            return [];
        }
        const found = leftoversToEnd(previous, table, this.#bootId);
        const ended: ProcessInfo[] = [];
        for (const { record, processes } of found) {
            // Every process here is a RECORDED one, the same process now (pid, start time, name), or started under one
            // after it: no guess for the session cap to doubt. A Playwright Chrome under a leftover Claude is all ended.
            tree.killTree(processes, table, Number.POSITIVE_INFINITY);
            ended.push(...processes);
            log(sweepLine(record, processes));
        }
        this.#records = this.#records.filter((r) => r.bootId === this.#bootId);
        this.#save();
        return ended;
    }

    /** Resolves once every change so far is on disk. */
    flushed(): Promise<void> {
        return this.#writes;
    }

    #same(a: { kind: string; ownerId: string; run: number }, b: { kind: string; ownerId: string; run: number }): boolean {
        return a.kind === b.kind && a.ownerId === b.ownerId && a.run === b.run;
    }

    #save(): void {
        const value = { records: this.#records };
        this.#writes = writeJsonAtomic(this.#file, value).catch(() => { /* the next change writes the whole ledger again */ });
    }
}

function isRecord(value: unknown): value is LedgerRecord {
    if (typeof value !== 'object' || value === null) return false;
    const r = value as Record<string, unknown>;
    return typeof r['kind'] === 'string' && typeof r['ownerId'] === 'string' && typeof r['run'] === 'number' && typeof r['bootId'] === 'string'
        && Array.isArray(r['processes']) && (r['processes'] as unknown[]).every((p) => {
            const q = p as Record<string, unknown>;
            return typeof q === 'object' && q !== null && typeof q['pid'] === 'number' && typeof q['ppid'] === 'number' && typeof q['started'] === 'number' && typeof q['name'] === 'string';
        });
}
