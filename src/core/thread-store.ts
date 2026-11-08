import { createHash } from 'node:crypto';
import { mkdir, open, readFile, rename, stat, truncate, unlink, writeFile, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { FileSessionStore, Thread, type JsonObject, type SessionStore } from '@particle-academy/prism-harness';
import { threadKeyFor, type AgentId } from './identity.js';
import type { StreamEvent } from './stream-event.js';
import { boundToolEvent, toolOutputFileName, utf8Bytes } from './tool-row-bound.js';

/**
 * WHERE AN AGENT'S CONVERSATION LIVES BETWEEN RUNS.
 *
 * ## Why `prism-harness`, and only half of it
 *
 * Durability is a solved problem in the kit and hand-rolling it would be strictly worse. A
 * `SessionStore` **declares its own `durability()`** rather than having it inferred, because
 * only the application knows whether its backing store is persistent or a disposable cache —
 * and the difference decides whether losing the contents is a shrug or a half-executed agent
 * action that was waiting on a human. `withLock` is on the store interface for the real race:
 * a run finishing while the user sends another message is ordinary, not exotic.
 *
 * We use that half and **not** `AgentRuntime`. Confirmed with the package's own author
 * (2026-10-10, read from source at `prism-harness-ts` 0.6.0 c35ddd9): the package contains
 * **zero** references to ACP, and `AgentRuntime` takes `LlmClient = (request) => Promise<
 * LlmResponse>` — a request/response call, i.e. **Prism itself is the agent**. Genie's agent
 * is an external CLI that owns its own thread on the provider side over a streaming
 * protocol. The two cannot both own the loop.
 *
 * Taking durability without the runtime is therefore the **intended seam**, not a
 * workaround: nothing in the store path knows who runs the loop. There is **no ACP-backed
 * thread adapter planned**, so the ACP-update → message mapping is ours permanently.
 *
 * So a change confined to `AgentRuntime` does not reach Genie. 0.8.0 is one: a model step that finishes
 * `error`/`unknown` now ends the run with `model_step_failed` instead of invoking its tools, and nothing here
 * runs model steps. `Thread`, `FileSessionStore` and `SessionStore` are unchanged from 0.7.0.
 */

/**
 * The durable store for one workstation.
 *
 * `FileSessionStore` reports `durable`, which is what lets it hold a thread and a pending
 * approval. Never pass an ephemeral store here — the manager would refuse it, and that
 * refusal is a guard we are relying on rather than a formality.
 */
export function openDurableStore(directory: string): SessionStore {
    return new ThreadStore(directory);
}

/** How much of a thread log one read takes: the event loop runs between chunks. */
const CHUNK_BYTES = 1 << 20;

/**
 * prism-harness's file store, plus what a LONG thread needs (genie#1340): its log read from the END, and its length
 * COUNTED rather than parsed.
 *
 * The harness answers `logLength` — which every `Thread.record` asks first, for the next position — from a count it keeps
 * only for the instance that last read or wrote the log, and otherwise by parsing every line (`readLog`). Each run's first
 * write paid that: 266k lines for the owner's largest thread, on the main process. Here the count is newlines, counted in
 * chunks, and kept per log with the size it was counted at:
 *
 *  - asked again at that size, it is answered from a `stat`, as the harness's own is;
 *  - this store's own append moves it on by the entries appended (one line each), when the log was exactly that size
 *    and ended on a whole line before it — the append runs under the thread's lock, so nobody else wrote between;
 *  - grown by anyone else, only the bytes since are counted — trusted only while the byte it ended on is still a newline
 *    (a crash's torn tail is cut back by the next append, which would otherwise leave a stale count).
 *
 * Writes and reads are otherwise the harness's own.
 */
export class ThreadStore extends FileSessionStore {
    readonly #directory: string;
    /** Per log: the size counted at, the newlines before it, and whether its last byte was one (no torn tail). */
    readonly #counts = new Map<string, { size: number; count: number; clean: boolean }>();
    readonly #rotateBytes: number;
    readonly #slowMs: number;
    readonly #onSlow: ((line: string) => void) | null;
    /** Per key: its rotated segments, oldest first, as the index on disk says (Tynn #557). */
    readonly #segments = new Map<string, Segment[]>();
    /** Per key: the summary pass over its segments not yet indexed, while it runs. */
    readonly #indexingRuns = new Map<string, Promise<void>>();

    constructor(directory: string, options: ThreadStoreOptions = {}) {
        super(directory);
        this.#directory = directory;
        this.#rotateBytes = options.rotateBytes ?? THREAD_ROTATE_BYTES;
        this.#slowMs = options.slowMs ?? STORE_SLOW_MS;
        this.#onSlow = options.onSlow ?? null;
    }

    /** One IO step, timed: past the threshold it is logged by name, so the next stall says which step it was. */
    async #timed<T>(step: string, key: string, run: () => Promise<T>): Promise<T> {
        const started = performance.now();
        try {
            return await run();
        } finally {
            const ms = performance.now() - started;
            const log = this.#onSlow ?? slowLog;
            if (log !== null && ms >= this.#slowMs) {
                try { log(`thread-store slow step=${step} ms=${Math.round(ms)} log=${ledgerName(key)}`); } catch { /* a log that throws costs nothing */ }
            }
        }
    }

    #indexFile(key: string): string { return join(this.#directory, `${ledgerName(key)}.segments.json`); }

    /** The key's rotated segments, oldest first; none when it never rotated. */
    async #index(key: string): Promise<Segment[]> {
        const known = this.#segments.get(key);
        if (known) return known;
        let list: Segment[] = [];
        try {
            const parsed = JSON.parse(await readFile(this.#indexFile(key), 'utf8')) as { v?: unknown; segments?: unknown };
            if (parsed.v === 1 && Array.isArray(parsed.segments)) list = parsed.segments as Segment[];
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        this.#segments.set(key, list);
        return list;
    }

    async #saveIndex(key: string, list: readonly Segment[]): Promise<void> {
        const file = this.#indexFile(key), temp = `${file}.${process.pid}.tmp`;
        await writeFile(temp, JSON.stringify({ v: 1, segments: list }), 'utf8');
        await rename(temp, file);
    }

    /** The key's segments, NEWEST first, each with its path: what a reader pages into once the active log is read. */
    async segmentsNewestFirst(key: string): Promise<Array<Segment & { path: string }>> {
        return [...(await this.#index(key))].reverse().map((seg) => ({ ...seg, path: join(this.#directory, seg.file) }));
    }

    /** Resolves when every segment of the key is summarised (a rotated log's one async, chunked pass). */
    indexing(key: string): Promise<void> {
        return this.#indexingRuns.get(key) ?? Promise.resolve();
    }

    /**
     * ROTATE (Tynn #557): the active log at or past the bound becomes the next segment — renamed, never copied — and a
     * new active log starts. Its line count goes in the index at once (positions run on); its summary follows in the
     * background, one chunked pass. Runs inside `appendLog`, under the thread's lock.
     */
    async #rotate(key: string, path: string): Promise<void> {
        const size = await this.#repairTail(key, path);
        if (size === 0) return;
        const known = this.#counts.get(key);
        const lines = known !== undefined && known.size === size && known.clean ? known.count : await countLines(path, size);
        const list = [...(await this.#index(key))];
        const seq = list.reduce((m, seg) => Math.max(m, seg.seq), 0) + 1;
        const file = `${ledgerName(key)}.${String(seq).padStart(6, '0')}.jsonl`;
        await this.#timed('rotate', key, () => rename(path, join(this.#directory, file)));
        // The harness's line-count sidecar (prism-harness >= 0.10.2, `<log>.index.json`) matched the file by size, times,
        // inode and device; the rename changed its ctime, so it is removed, never moved.
        await unlink(`${path}${LOG_SIDECAR}`).catch(() => undefined);
        list.push({ seq, file, lines, bytes: size, summary: null });
        this.#segments.set(key, list);
        await this.#saveIndex(key, list);
        this.#counts.set(key, { size: 0, count: 0, clean: true });
        this.#summarise(key);
    }

    /** Summarise every segment of the key that has none, once, in the background. */
    #summarise(key: string): void {
        if (this.#indexingRuns.has(key)) return;
        const run = (async () => {
            const list = await this.#index(key);
            for (const seg of list) {
                if (seg.summary !== null) continue;
                const summary = await this.#timed('index', key, () => summariseSegment(join(this.#directory, seg.file))).catch(() => null);
                if (summary === null) continue;
                seg.summary = summary;
                await this.#saveIndex(key, list).catch(() => undefined);
            }
        })().finally(() => { this.#indexingRuns.delete(key); });
        this.#indexingRuns.set(key, run);
    }

    /** Cut a torn tail back to the last newline (as the harness does); returns the size after. */
    async #repairTail(key: string, path: string): Promise<number> {
        const size = await sizeOf(path);
        if (size === null || size === 0) return 0;
        const handle = await open(path, 'r');
        let cut: number | null = null;
        try {
            if (await endsLine(handle, size)) return size;
            const chunk = Buffer.alloc(64 * 1024);
            let end = size;
            cut = 0;
            while (end > 0) {
                const start = Math.max(0, end - chunk.length);
                const { bytesRead } = await handle.read(chunk, 0, end - start, start);
                const newline = chunk.subarray(0, bytesRead).lastIndexOf(0x0a);
                if (newline !== -1) { cut = start + newline + 1; break; }
                end = start;
            }
        } finally {
            await handle.close();
        }
        await this.#timed('repair', key, () => truncate(path, cut!));
        this.#counts.delete(key);
        return cut!;
    }

    /** The key's log file: see {@link threadLogFile}. */
    logFile(key: string): string {
        return join(this.#directory, `${ledgerName(key)}.jsonl`);
    }

    /**
     * A tool call's WHOLE output (BOUNDED-LEDGERS-386; Tynn story #386): `<ledger>/tool-<id>.out`, in a folder named like the
     * key's log, beside it. The row keeps a 16 KB preview and names this file (core/tool-row-bound.ts).
     */
    toolOutputFile(key: string, toolCallId: string): string {
        return join(this.#directory, ledgerName(key), toolOutputFileName(toolCallId));
    }

    async writeToolOutput(key: string, toolCallId: string, text: string): Promise<void> {
        await mkdir(join(this.#directory, ledgerName(key)), { recursive: true });
        await writeFile(this.toolOutputFile(key, toolCallId), text, 'utf8');
    }

    /** At most `maxBytes` of a call's kept output, cut on a character; `null` when none was kept. */
    async readToolOutput(key: string, toolCallId: string, maxBytes: number): Promise<{ text: string; bytes: number; cut: boolean } | null> {
        let handle: FileHandle;
        try {
            handle = await open(this.toolOutputFile(key, toolCallId), 'r');
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
            throw error;
        }
        try {
            const { size } = await handle.stat();
            const want = Math.max(0, Math.min(size, maxBytes));
            const buf = Buffer.allocUnsafe(want);
            let got = 0;
            while (got < want) {
                const { bytesRead } = await handle.read(buf, got, want - got, got);
                if (bytesRead === 0) break;
                got += bytesRead;
            }
            let end = got;
            if (got < size) while (end > 0 && (buf[end]! & 0xc0) === 0x80) end -= 1;
            return { text: buf.subarray(0, end).toString('utf8'), bytes: size, cut: end < size };
        } finally {
            await handle.close();
        }
    }

    override async logLength(key: string): Promise<number | null> {
        const segments = await this.#index(key);
        const before = segments.reduce((n, seg) => n + seg.lines, 0);
        const active = await this.#activeLength(key);
        if (active === null) return segments.length > 0 ? before : null;
        return before + active;
    }

    /** The ACTIVE log's line count (the segments' are in the index). */
    async #activeLength(key: string): Promise<number | null> {
        const size = await sizeOf(this.logFile(key));
        if (size === null) return null;
        const known = this.#counts.get(key);
        if (known !== undefined && known.size === size) return known.count;
        const handle = await open(this.logFile(key), 'r');
        try {
            const base = known !== undefined && known.size < size && (known.size === 0 || (await endsLine(handle, known.size))) ? known : undefined;
            const from = base?.size ?? 0;
            let count = base?.count ?? 0;
            let clean = from === 0 || base!.clean;
            const buf = Buffer.allocUnsafe(Math.min(CHUNK_BYTES, Math.max(1, size - from)));
            for (let at = from; at < size;) {
                const { bytesRead } = await handle.read(buf, 0, Math.min(buf.length, size - at), at);
                if (bytesRead === 0) break;
                for (let i = buf.indexOf(0x0a); i !== -1 && i < bytesRead; i = buf.indexOf(0x0a, i + 1)) count += 1;
                clean = buf[bytesRead - 1] === 0x0a;
                at += bytesRead;
            }
            this.#counts.set(key, { size, count, clean });
            return count;
        } finally {
            await handle.close();
        }
    }

    /**
     * The harness's append — one write of whole lines, then synced, a torn tail cut first — with each step timed, and the
     * log ROTATED first when it has reached the bound (Tynn #557). A log left by an older Genie rotates on its next append.
     */
    override async appendLog(key: string, entries: Parameters<FileSessionStore['appendLog']>[1]): Promise<void> {
        const path = this.logFile(key);
        try {
            await mkdir(this.#directory, { recursive: true });
            const current = await sizeOf(path);
            if (current !== null && current >= this.#rotateBytes) await this.#rotate(key, path);
            else if ((await this.#index(key)).some((seg) => seg.summary === null)) this.#summarise(key);
            const known = this.#counts.get(key);
            const before = await this.#repairTail(key, path);
            const data = entries.map((entry) => `${JSON.stringify(entry)}\n`).join('');
            const handle = await this.#timed('open', key, () => open(path, 'a'));
            try {
                if (data !== '') await this.#timed('write', key, () => handle.write(data));
                await this.#timed('sync', key, () => handle.sync());
            } finally {
                await this.#timed('close', key, () => handle.close());
            }
            const after = this.#counts.get(key);
            if (after !== undefined && after === known && after.clean && after.size === before) this.#counts.set(key, { size: before + Buffer.byteLength(data), count: after.count + entries.length, clean: true });
            else this.#counts.delete(key);
        } catch (error) {
            this.#counts.delete(key);
            throw error;
        }
    }

    /** Every line, oldest first, across the segments and the active log: the WHOLE read (`Thread.messages`). */
    override async readLog(key: string): Promise<JsonObject[] | null> {
        const segments = await this.#index(key);
        const active = await this.#timed('readLog', key, () => super.readLog(key));
        if (segments.length === 0) return active;
        const out: JsonObject[] = [];
        for (const seg of segments) out.push(...(await readEntries(join(this.#directory, seg.file), key)));
        if (active !== null) out.push(...active);
        return out;
    }

    /** Cleared: the segments and their index go too. */
    override async clearLog(key: string): Promise<void> {
        for (const seg of await this.#index(key)) {
            await unlink(join(this.#directory, seg.file)).catch(() => undefined);
            await unlink(join(this.#directory, `${seg.file}${LOG_SIDECAR}`)).catch(() => undefined);
        }
        await unlink(this.#indexFile(key)).catch(() => undefined);
        await unlink(`${this.logFile(key)}${LOG_SIDECAR}`).catch(() => undefined);
        this.#segments.set(key, []);
        this.#counts.delete(key);
        await super.clearLog(key);
    }

    /**
     * The log's complete lines, NEWEST FIRST, a chunk at a time (each chunk's lines newest first). A torn last line — a
     * write a crash cut short — is not a line, as in the harness's own read. Nothing when there is no log.
     */
    async *linesFromEnd(key: string): AsyncGenerator<Buffer[]> {
        yield* linesFromEndOf(this.logFile(key));
        for (const seg of await this.segmentsNewestFirst(key)) yield* linesFromEndOf(seg.path);
    }

    /** The ACTIVE log's lines, newest first (its segments are paged separately: `segmentsNewestFirst`). */
    activeLinesFromEnd(key: string): AsyncGenerator<Buffer[]> {
        return linesFromEndOf(this.logFile(key));
    }
}

/** A file's complete lines, NEWEST FIRST, a chunk at a time. A torn last line is not a line. Nothing when there is no file. */
export async function* linesFromEndOf(path: string): AsyncGenerator<Buffer[]> {
    {
        let handle: FileHandle;
        try {
            handle = await open(path, 'r');
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
            throw error;
        }
        try {
            const { size } = await handle.stat();
            let end = size;
            let carry: Buffer | null = null;
            let tornCut = false;
            while (end > 0) {
                const start = Math.max(0, end - CHUNK_BYTES);
                const read = Buffer.allocUnsafe(end - start);
                await handle.read(read, 0, read.length, start);
                const block: Buffer = carry === null ? read : Buffer.concat([read, carry]);
                end = start;
                let stop = block.length;
                if (!tornCut) {
                    // Everything after the log's last newline is a write that never finished.
                    const nl = block.lastIndexOf(0x0a);
                    if (nl === -1) { carry = block; continue; }
                    stop = nl;
                    tornCut = true;
                }
                const lines: Buffer[] = [];
                let nl = stop > 0 ? block.lastIndexOf(0x0a, stop - 1) : -1;
                while (nl !== -1) {
                    lines.push(block.subarray(nl + 1, stop));
                    stop = nl;
                    nl = stop > 0 ? block.lastIndexOf(0x0a, stop - 1) : -1;
                }
                // The block's first line may begin in the chunk before: carried until that is read (or the file starts).
                carry = block.subarray(0, stop);
                if (lines.length > 0) yield lines;
            }
            if (tornCut && carry !== null) yield [carry];
        } finally {
            await handle.close();
        }
    }
}

/** prism-harness's line-count sidecar beside a log (0.10.2+): `<log>.index.json`. */
const LOG_SIDECAR = '.index.json';
/** How big a thread log grows before it rotates (Tynn #557). */
export const THREAD_ROTATE_BYTES = 64 * 1024 * 1024;
/** A store step this slow is logged by name. */
export const STORE_SLOW_MS = 200;
export type ThreadStoreOptions = { rotateBytes?: number; slowMs?: number; onSlow?: (line: string) => void };
let slowLog: ((line: string) => void) | null = null;
/** Where every store's slow steps are logged (genie-host: its lifecycle log). */
export function setThreadStoreSlowLog(log: ((line: string) => void) | null): void { slowLog = log; }

/** What the index keeps of a segment, so a reader never opens it unless a page needs its rows (Tynn #557). */
export type SegmentSummary = {
    /** Rows a history read keeps with no options, and the turns among them, and the highest turn. */
    rows: number; turns: number; lastTurn: number;
    /** The runs whose rows it holds, and the newest time of a row that names no run (the `before` rule's only rows). */
    runs: string[]; unstampedNewestAt: number | null;
    /** Its prompt rows (run, a pending message, prompt_delivery), as stored lines, oldest first. */
    prompt: string[];
};
export type Segment = { seq: number; file: string; lines: number; bytes: number; summary: SegmentSummary | null };

/** One pass over a segment, newest first, a chunk at a time: what its summary says. */
async function summariseSegment(path: string): Promise<SegmentSummary> {
    let rows = 0, turns = 0, lastTurn = 0, unstampedNewestAt: number | null = null;
    const runs = new Set<string>();
    const prompt: string[] = [];
    for await (const lines of linesFromEndOf(path)) {
        for (const line of lines) {
            const entry = JSON.parse(line.toString('utf8')) as Record<string, unknown>;
            const message = entry.message as Record<string, unknown> | null;
            if (typeof message !== 'object' || message === null || Array.isArray(message)) throw new Error('a stored thread entry has no message object');
            const writtenBy = message[RUN_FIELD];
            if (typeof writtenBy === 'string') runs.add(writtenBy);
            else {
                const at = Date.parse(typeof entry.recorded_at === 'string' ? entry.recorded_at : '');
                if (Number.isFinite(at) && (unstampedNewestAt === null || at > unstampedNewestAt)) unstampedNewestAt = at;
            }
            const row = historyRow({ position: typeof entry.position === 'number' ? entry.position : 0, message, recordedAt: typeof entry.recorded_at === 'string' ? entry.recorded_at : '' }, {});
            if (row === null) continue;
            rows += 1;
            if (row.event.kind === 'turn') { turns += 1; if (row.event.n > lastTurn) lastTurn = row.event.n; }
            if (PROMPT_KINDS.has(row.event.kind) && (row.event.kind !== 'message' || Boolean((row.event as { pending?: unknown }).pending))) prompt.push(line.toString('utf8'));
        }
    }
    return { rows, turns, lastTurn, runs: [...runs], unstampedNewestAt, prompt: prompt.reverse() };
}

/** A segment's entries, oldest first (the whole read). */
async function readEntries(path: string, key: string): Promise<JsonObject[]> {
    const raw = await readFile(path, 'utf8');
    const lines = raw.split('\n');
    lines.pop();
    return lines.map((line, index) => {
        const entry: unknown = JSON.parse(line);
        if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) throw new Error(`line ${index + 1} of a thread log segment for [${key}] is not an object`);
        return entry as JsonObject;
    });
}

/** The newlines in a file, counted in chunks. */
async function countLines(path: string, size: number): Promise<number> {
    const handle = await open(path, 'r');
    try {
        let count = 0;
        const buf = Buffer.allocUnsafe(Math.min(CHUNK_BYTES, Math.max(1, size)));
        for (let at = 0; at < size;) {
            const { bytesRead } = await handle.read(buf, 0, Math.min(buf.length, size - at), at);
            if (bytesRead === 0) break;
            for (let i = buf.indexOf(0x0a); i !== -1 && i < bytesRead; i = buf.indexOf(0x0a, i + 1)) count += 1;
            at += bytesRead;
        }
        return count;
    } finally {
        await handle.close();
    }
}

/** The file's size, or `null` when there is none. */
function ledgerName(key: string): string {
    return createHash('sha256').update(key).digest('hex').slice(0, 32);
}

async function sizeOf(path: string): Promise<number | null> {
    try {
        return (await stat(path)).size;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
    }
}

/** Whether the byte before `size` is a newline: a count up to there ended on a whole line. */
async function endsLine(handle: FileHandle, size: number): Promise<boolean> {
    const one = Buffer.alloc(1);
    const { bytesRead } = await handle.read(one, 0, 1, size - 1);
    return bytesRead === 1 && one[0] === 0x0a;
}

/**
 * This agent's thread.
 *
 * **The key comes from `threadKeyFor` and from nowhere else.** That is the entire point of
 * this function existing rather than callers constructing a `Thread` themselves: the
 * previous build wrote under one id and read under another, and because an identity split
 * throws nothing, its Conversation tab was empty for four releases while every surface
 * downstream got blamed first.
 */
/** The field a recorded row names the run that wrote it in (stripped when the row is read back). */
export const RUN_FIELD = 'writtenByRun';

export function openAgentThread(store: SessionStore, agentId: AgentId): Thread {
    return new Thread(store, threadKeyFor(agentId));
}

/**
 * AN AGENT'S RECORDED HISTORY — every row the session wrote to its thread, with the time it was written. Claude does
 * not replay a resumed conversation to its client (prism-acp: `transcriptReplay: false`), so this record is the only
 * way the Agent view and the chat can show what came before this run; without it an agent remembered hundreds of
 * thousands of tokens of context while the UI showed one turn (the owner, beta.21).
 *
 * A running agent's CURRENT run is kept out — its rows are already live — by `run`: every row a run writes carries
 * that run's id ({@link RUN_FIELD}), so a row is this run's exactly when it says so. NOT by when it was written: a row
 * the previous run emitted but wrote in the same millisecond the next run started, or after it (a write still landing
 * on a quick restart), read as this run's and was shown by neither (main's CI, 2026-10-21: turn 1's `finished` row
 * gone). `before` (epoch ms) is that old rule, kept only for rows recorded before runs were named. `limit` keeps the
 * most recent rows; `earlier` says how many older ones were left out. A row written unserialisable is skipped.
 */
export type HistoryRow = { event: StreamEvent; at: number | null; position: number };
/** `lastTurn`: the highest turn number in the WHOLE record, window or not — where a new run's turns continue from. */
export type History = { rows: HistoryRow[]; earlier: number; earlierTurns: number; lastTurn: number };
/**
 * `maxBytes`: the most the rows read may come to, in bytes of JSON — the newest rows until it is reached, the rest
 * counted as `earlier`. Held to {@link HISTORY_MAX_BYTES} whatever the caller asks; applies with `limit`.
 */
export type HistoryOptions = { before?: number; run?: string; limit?: number; maxBytes?: number };

/**
 * THE MOST ONE HISTORY LOAD COMES TO, in bytes of JSON, whatever its caller asks (Tynn story #386). A row bound alone
 * let a boot load 3,000 rows of up to 238 KB each per resumed agent, and the window's main hung on it.
 */
export const HISTORY_MAX_BYTES = 4 * 1024 * 1024;

function byteBound(options: HistoryOptions): number {
    const asked = options.maxBytes;
    return typeof asked === 'number' && Number.isFinite(asked) ? Math.max(0, Math.min(HISTORY_MAX_BYTES, Math.floor(asked))) : HISTORY_MAX_BYTES;
}

/** A row's size as the load counts it: its event and time, as JSON. */
function rowBytes(row: HistoryRow): number {
    return utf8Bytes(JSON.stringify({ event: row.event, at: row.at }));
}

/** One stored message as a history row, or `null` when the read leaves it out (see {@link readHistory}). */
function historyRow(m: { position: number; message: unknown; recordedAt: string }, options: HistoryOptions): HistoryRow | null {
    const at = Date.parse(m.recordedAt);
    const { [RUN_FIELD]: writtenBy, ...message } = m.message as Record<string, unknown>;
    if (typeof writtenBy === 'string') {
        if (options.run !== undefined && writtenBy === options.run) return null;
    } else if (options.before !== undefined && Number.isFinite(at) && at >= options.before) return null;
    if (typeof message.kind !== 'string' || message.unserialisable === true) return null;
    // An OLD ledger is read bounded, never rewritten: an oversized tool row is cut to its preview here (Tynn story #386).
    const { event } = boundToolEvent(message as unknown as StreamEvent, { sidecar: false });
    return { event, at: Number.isFinite(at) ? at : null, position: m.position };
}

/**
 * The history from EVERY row of the thread: what a caller that needs all of it reads (a draft's delivery state can be
 * anywhere in it), and the reference {@link readHistory}'s bounded read is checked against.
 */
export async function readWholeHistory(store: SessionStore, agentId: AgentId, options: HistoryOptions = {}): Promise<History> {
    const messages = await openAgentThread(store, agentId).messages();
    const rows: HistoryRow[] = [];
    for (const m of messages) {
        const row = historyRow(m, options);
        if (row) rows.push(row);
    }
    let earlier = Math.max(0, rows.length - (options.limit ?? rows.length));
    if (options.limit !== undefined) {
        const maxBytes = byteBound(options);
        let bytes = 0;
        for (let i = rows.length - 1; i >= earlier; i -= 1) {
            bytes += rowBytes(rows[i]!);
            if (bytes > maxBytes) { earlier = i + 1; break; }
        }
    }
    // The turns the window cut off: the turns shown number on from them.
    const earlierTurns = rows.slice(0, earlier).filter((r) => r.event.kind === 'turn').length;
    return { rows: rows.slice(earlier), earlier, earlierTurns, lastTurn: lastTurnOf(rows) };
}

/**
 * AN AGENT'S HISTORY, AT THE COST OF THE WINDOW IT KEEPS (genie#1340; the owner, 2026-10-29: "right after a restart genie
 * ui lags a lot … it took 4 seconds before the text showed up").
 *
 * With a `limit` and Genie's own store, the thread log is read FROM ITS END, a chunk at a time: the newest lines are
 * parsed until the window holds `limit` rows, and every line before them is only COUNTED — `JSON.parse` touches one
 * only when its bytes say it may matter: a turn (`"turn"` — never inside a JSON string, where every quote is escaped,
 * except a string that ends in `"turn`, which is parsed and found not to be one), a row written unserialisable, a row
 * of the run being kept out, a row whose message does not open with its kind, or one from before runs were named that
 * was written at or after `before`. The answer is exactly the whole read's (test/thread-history-bounded.test.ts proves it
 * against {@link readWholeHistory}); the cost is the window plus a byte scan, in chunks the event loop runs between.
 *
 * Before: every read parsed every line, in one synchronous run — 266k lines for the owner's largest thread, on Electron's
 * main process, which is the thread that routes every keystroke to the window — and kept 3000.
 *
 * Without a `limit` (every row is wanted) or with another store, it is {@link readWholeHistory}.
 */
export async function readHistory(store: SessionStore, agentId: AgentId, options: HistoryOptions = {}): Promise<History> {
    if (options.limit === undefined || !(store instanceof ThreadStore)) return readWholeHistory(store, agentId, options);
    const limit = Math.max(0, options.limit);
    const maxBytes = byteBound(options);
    const newestFirst: HistoryRow[] = [];
    let bytes = 0;
    // The window is full: `limit` rows, or the next row would pass `maxBytes`. Everything older is `earlier`.
    let full = limit === 0;
    let earlier = 0;
    let earlierTurns = 0;
    let lastTurn = 0;
    const runToken = options.run === undefined ? null : Buffer.from(`"${RUN_FIELD}":${JSON.stringify(options.run)}`);
    const rowOf = (line: Buffer): HistoryRow | null => {
        const entry: unknown = JSON.parse(line.toString('utf8'));
        if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) throw new Error(`a line of the thread log for ${agentId} is not an object`);
        const e = entry as Record<string, unknown>;
        if (typeof e.message !== 'object' || e.message === null || Array.isArray(e.message)) throw new Error(`a stored thread entry for ${agentId} has no message object`);
        return historyRow({ position: typeof e.position === 'number' ? e.position : 0, message: e.message, recordedAt: typeof e.recorded_at === 'string' ? e.recorded_at : '' }, options);
    };
    /** One stored line, newest first; what it adds to the window or the count. Returns whether it was a row, and a turn. */
    const take = (line: Buffer): { row: boolean; turn: boolean } => {
        if (!full || mayMatter(line, runToken, options.before)) {
            const row = rowOf(line);
            if (row === null) return { row: false, turn: false };
            const turn = row.event.kind === 'turn';
            if (row.event.kind === 'turn' && row.event.n > lastTurn) lastTurn = row.event.n;
            if (!full) {
                const size = rowBytes(row);
                if (bytes + size <= maxBytes) {
                    bytes += size;
                    newestFirst.push(row);
                    if (newestFirst.length >= limit) full = true;
                    return { row: true, turn };
                }
                full = true;
            }
            earlier += 1;
            if (turn) earlierTurns += 1;
            return { row: true, turn };
        }
        // A plain row of an earlier run: in the record, before the window, and not a turn.
        earlier += 1;
        return { row: true, turn: false };
    };
    const key = threadKeyFor(agentId);
    for await (const lines of store.activeLinesFromEnd(key)) for (const line of lines) take(line);
    /*
     * THE SEGMENTS (Tynn #557), newest first. One whose summary answers for this read — no row of the run kept out, no
     * unnamed row at or after `before` — is read only while the window still needs rows; the rest of it is counted from
     * its summary. Any other segment is read as the active log is.
     */
    for (const seg of await store.segmentsNewestFirst(key)) {
        const summary = seg.summary;
        const answers = summary !== null && (options.run === undefined || !summary.runs.includes(options.run)) && (options.before === undefined || summary.unstampedNewestAt === null || summary.unstampedNewestAt < options.before);
        if (!answers) {
            for await (const lines of linesFromEndOf(seg.path)) for (const line of lines) take(line);
            continue;
        }
        let rowsHere = 0, turnsHere = 0;
        if (!full) {
            outer: for await (const lines of linesFromEndOf(seg.path)) {
                for (const line of lines) {
                    const taken = take(line);
                    if (taken.row) rowsHere += 1;
                    if (taken.turn) turnsHere += 1;
                    if (full) break outer;
                }
            }
        }
        earlier += summary.rows - rowsHere;
        earlierTurns += summary.turns - turnsHere;
        if (summary.lastTurn > lastTurn) lastTurn = summary.lastTurn;
    }
    return { rows: newestFirst.reverse(), earlier, earlierTurns, lastTurn };
}

/**
 * THE ROWS THAT DECIDE WHICH PROMPTS ARE OWED (beta.53 freezes; Windows logged AppHangTransient for Genie.exe on the
 * owner's machine, main's thread not pumping for 5 s+): every `run`, every message with a `pending` draft, every
 * `prompt_delivery` — in order, as {@link readWholeHistory} would give them, and nothing else. What `core/prompt-delivery.ts`
 * `promptDeliveries` reads, and where a draft's text and content are found.
 *
 * A draft's state can be anywhere in the record, so the whole log is READ — but from the end in chunks the event loop runs
 * between (`linesFromEnd`), and a line is handed to `JSON.parse` only when its bytes say it may be one of those rows, or
 * it is not written the way the store writes (as in {@link readHistory}: inside a JSON string every quote is escaped, so
 * `"pending":{` or `"kind":"run"` in a row's TEXT never matches). Before, Send on a draft and every Restart parsed every
 * line of a 24–374 MB log in one synchronous run on main.
 */
export async function readPromptRows(store: SessionStore, agentId: AgentId): Promise<{ rows: HistoryRow[] }> {
    if (!(store instanceof ThreadStore)) {
        const whole = await readWholeHistory(store, agentId);
        return { rows: whole.rows.filter((r) => PROMPT_KINDS.has(r.event.kind) && (r.event.kind !== 'message' || Boolean((r.event as { pending?: unknown }).pending))) };
    }
    const newestFirst: HistoryRow[] = [];
    const key = threadKeyFor(agentId);
    // The active log is read; a summarised segment answers from its index (Tynn #557), any other is read.
    const sources: Array<AsyncIterable<Buffer[]>> = [store.activeLinesFromEnd(key)];
    for (const seg of await store.segmentsNewestFirst(key)) {
        const summary = seg.summary;
        sources.push(summary !== null ? (async function* () { yield [...summary.prompt].reverse().map((l) => Buffer.from(l, 'utf8')); })() : linesFromEndOf(seg.path));
    }
    for (const source of sources) for await (const lines of source) {
        for (const line of lines) {
            if (opensWithKind(line) && !line.includes(PENDING) && !line.includes(KIND_RUN) && !line.includes(KIND_DELIVERY)) continue;
            const entry: unknown = JSON.parse(line.toString('utf8'));
            if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) throw new Error(`a line of the thread log for ${agentId} is not an object`);
            const e = entry as Record<string, unknown>;
            if (typeof e.message !== 'object' || e.message === null || Array.isArray(e.message)) throw new Error(`a stored thread entry for ${agentId} has no message object`);
            const row = historyRow({ position: typeof e.position === 'number' ? e.position : 0, message: e.message, recordedAt: typeof e.recorded_at === 'string' ? e.recorded_at : '' }, {});
            if (row === null || !PROMPT_KINDS.has(row.event.kind)) continue;
            if (row.event.kind === 'message' && !(row.event as { pending?: unknown }).pending) continue;
            newestFirst.push(row);
        }
    }
    return { rows: newestFirst.reverse() };
}

const PROMPT_KINDS = new Set(['run', 'message', 'prompt_delivery']);
const PENDING = Buffer.from('"pending":{');
const KIND_RUN = Buffer.from('"kind":"run"');
const KIND_DELIVERY = Buffer.from('"kind":"prompt_delivery"');
const POSITION = Buffer.from('{"position":');
const OPENS_WITH_KIND = Buffer.from(',"message":{"kind":"');
const TURN = Buffer.from('"turn"');
const UNSERIALISABLE = Buffer.from('"unserialisable"');
const RECORDED_AT = Buffer.from('"recorded_at":"');

/** `{"position":<n>,"message":{"kind":"` — the entry as the store writes it, its message opening with a string kind. */
function opensWithKind(line: Buffer): boolean {
    if (line.length < POSITION.length || line.compare(POSITION, 0, POSITION.length, 0, POSITION.length) !== 0) return false;
    let i = POSITION.length;
    while (i < line.length && line[i]! >= 0x30 && line[i]! <= 0x39) i += 1;
    return i > POSITION.length && line.length - i >= OPENS_WITH_KIND.length && line.compare(OPENS_WITH_KIND, 0, OPENS_WITH_KIND.length, i, i + OPENS_WITH_KIND.length) === 0;
}

/** Whether a stored line before the window must be PARSED to be counted exactly (see {@link readHistory}). */
function mayMatter(line: Buffer, runToken: Buffer | null, before: number | undefined): boolean {
    if (!opensWithKind(line) || line.includes(TURN) || line.includes(UNSERIALISABLE)) return true;
    if (runToken !== null && line.includes(runToken)) return true;
    if (before === undefined) return false;
    // Kept out by `before` only when it names no run; its time is the entry's last field, read without parsing the rest.
    const at = line.lastIndexOf(RECORDED_AT);
    if (at === -1) return true;
    const from = at + RECORDED_AT.length;
    const to = line.indexOf(0x22, from);
    const when = Date.parse(line.toString('latin1', from, to === -1 ? line.length : to));
    return !Number.isFinite(when) || when >= before;
}

/**
 * WHERE THE STORE KEEPS AN AGENT'S THREAD LOG: prism-harness FileSessionStore writes `<key digest>.jsonl` beside its payload,
 * the digest being the first 32 hex characters of the key's SHA-256. A durable on-disk name (changing it would orphan every
 * thread ever written), pinned against the real store by test/thread-history-bounded.test.ts.
 */
export function threadLogFile(directory: string, agentId: AgentId): string {
    return join(directory, `${createHash('sha256').update(threadKeyFor(agentId)).digest('hex').slice(0, 32)}.jsonl`);
}

/** The highest turn number in an agent's record (0 when none) — where its next run's turns continue from. */
export function lastTurnOf(rows: readonly { event: StreamEvent }[]): number {
    let n = 0;
    for (const r of rows) if (r.event.kind === 'turn' && r.event.n > n) n = r.event.n;
    return n;
}
