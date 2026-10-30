import { createHash } from 'node:crypto';
import { open, stat, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { FileSessionStore, Thread, type SessionStore } from '@particle-academy/prism-harness';
import { threadKeyFor, type AgentId } from './identity.js';
import type { StreamEvent } from './stream-event.js';

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

    constructor(directory: string) {
        super(directory);
        this.#directory = directory;
    }

    /** The key's log file: see {@link threadLogFile}. */
    logFile(key: string): string {
        return join(this.#directory, `${createHash('sha256').update(key).digest('hex').slice(0, 32)}.jsonl`);
    }

    override async logLength(key: string): Promise<number | null> {
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

    override async appendLog(key: string, entries: Parameters<FileSessionStore['appendLog']>[1]): Promise<void> {
        const known = this.#counts.get(key);
        const before = known === undefined ? null : await sizeOf(this.logFile(key));
        try {
            await super.appendLog(key, entries);
        } catch (error) {
            this.#counts.delete(key);
            throw error;
        }
        const after = known !== undefined && known.clean && before === known.size ? await sizeOf(this.logFile(key)) : null;
        if (known !== undefined && after !== null) this.#counts.set(key, { size: after, count: known.count + entries.length, clean: true });
        else this.#counts.delete(key);
    }

    /**
     * The log's complete lines, NEWEST FIRST, a chunk at a time (each chunk's lines newest first). A torn last line — a
     * write a crash cut short — is not a line, as in the harness's own read. Nothing when there is no log.
     */
    async *linesFromEnd(key: string): AsyncGenerator<Buffer[]> {
        let handle: FileHandle;
        try {
            handle = await open(this.logFile(key), 'r');
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

/** The file's size, or `null` when there is none. */
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
export type HistoryOptions = { before?: number; run?: string; limit?: number };

/** One stored message as a history row, or `null` when the read leaves it out (see {@link readHistory}). */
function historyRow(m: { position: number; message: unknown; recordedAt: string }, options: HistoryOptions): HistoryRow | null {
    const at = Date.parse(m.recordedAt);
    const { [RUN_FIELD]: writtenBy, ...message } = m.message as Record<string, unknown>;
    if (typeof writtenBy === 'string') {
        if (options.run !== undefined && writtenBy === options.run) return null;
    } else if (options.before !== undefined && Number.isFinite(at) && at >= options.before) return null;
    if (typeof message.kind !== 'string' || message.unserialisable === true) return null;
    return { event: message as unknown as StreamEvent, at: Number.isFinite(at) ? at : null, position: m.position };
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
    const limit = options.limit ?? rows.length;
    const earlier = Math.max(0, rows.length - limit);
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
    const newestFirst: HistoryRow[] = [];
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
    for await (const lines of store.linesFromEnd(threadKeyFor(agentId))) {
        for (const line of lines) {
            if (newestFirst.length < limit || mayMatter(line, runToken, options.before)) {
                const row = rowOf(line);
                if (row === null) continue;
                if (row.event.kind === 'turn' && row.event.n > lastTurn) lastTurn = row.event.n;
                if (newestFirst.length < limit) { newestFirst.push(row); continue; }
                earlier += 1;
                if (row.event.kind === 'turn') earlierTurns += 1;
            } else {
                // A plain row of an earlier run: in the record, before the window, and not a turn.
                earlier += 1;
            }
        }
    }
    return { rows: newestFirst.reverse(), earlier, earlierTurns, lastTurn };
}

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
