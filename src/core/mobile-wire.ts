import { isExecutableName } from './inbox.js';

/**
 * THE PHONE'S WIRE (2026-10-30, genie#1346) — the pure half of what crosses the tailnet to a phone, and why it is small.
 *
 * Genie 1 streamed terminals to the phone; Genie 2's remote socket, before this, sent a phone every agent's WHOLE detail
 * (its ledger, thousands of rows) up to every 50 ms, and every terminal's bytes. A phone shows one agent at a time, so:
 *
 *  - THE LEDGER WINDOW. A watched agent opens on its last `MOBILE_TAIL` rows and is then kept live by patches against what
 *    the phone holds (`keep` rows, then `append`), by row IDENTITY like `agent-push-wire.ts`. A phone that slept resumes
 *    from a CURSOR — its first row and the last row it trusts — and receives only what came after (`base: 'resume'`).
 *    A cursor the host cannot place is answered with a fresh tail, never a guess.
 *  - UPLOADS IN CHUNKS. fancy-ws closes any frame over 1 MiB, and a phone photo is 2–5 MB: bytes cross as chunks of
 *    `UPLOAD_CHUNK_BYTES`, staged PER CONNECTION, in order, against a declared size no larger than `UPLOAD_MAX_BYTES`,
 *    and are taken ONCE by the call (an upload into the workspace, a prompt's attachment) that passed its gates.
 */

/** How many of a watched agent's newest rows a phone opens on. */
export const MOBILE_TAIL = 200;
/** One chunk's raw bytes. Base64 inside a JSON frame it is ~342 KiB — far under fancy-ws's 1 MiB frame cap. */
export const UPLOAD_CHUNK_BYTES = 256 * 1024;
/** The most one upload may be (Genie 1's MAX_UPLOAD_BYTES; the inbox's per-file cap). */
export const UPLOAD_MAX_BYTES = 25 * 1024 * 1024;
/** How many uploads one connection may hold open at once. */
const MAX_OPEN_PER_OWNER = 3;
/** An upload not finished and taken within this is dropped. */
const STAGE_TTL_MS = 10 * 60_000;

export interface WireRow {
    readonly id: string;
}

export interface WatchOptions {
    /** How many newest rows to open on; default `MOBILE_TAIL`. */
    readonly tail?: number;
    /** The rows the phone already holds: its first, and the last it trusts. */
    readonly resume?: WindowCursor | null;
}

export interface WindowCursor {
    readonly from: string;
    readonly after: string;
}

/** `base: null` = these rows are the whole window; a number = a patch on that push; `'resume'` = keep your first `keep`. */
export interface WindowRows<R> {
    readonly base: number | null | 'resume';
    readonly keep: number;
    readonly append: readonly R[];
}

/** What the host holds of one phone's window on one agent: where it starts in the ledger, and what was last sent. */
export interface WindowState<R> {
    readonly seq: number;
    readonly offset: number;
    readonly rows: readonly R[];
    readonly tail: number;
}

const tailOf = (options: WatchOptions): number => Math.max(1, Math.min(5000, Math.floor(options.tail ?? MOBILE_TAIL)));

function fresh<R extends WireRow>(rows: readonly R[], tail: number, seq: number): { state: WindowState<R>; rows: WindowRows<R> } {
    const offset = Math.max(0, rows.length - tail);
    const window = rows.slice(offset);
    return { state: { seq, offset, rows: window, tail }, rows: { base: null, keep: 0, append: window } };
}

/** The first push to a phone that watches an agent: a tail, or — given a cursor the host can place — only what is new. */
export function openWindow<R extends WireRow>(rows: readonly R[], options: WatchOptions = {}): { state: WindowState<R>; rows: WindowRows<R> } {
    const tail = tailOf(options);
    const cursor = options.resume ?? null;
    if (cursor) {
        const from = rows.findIndex((r) => r.id === cursor.from);
        const after = from < 0 ? -1 : rows.findIndex((r, i) => i >= from && r.id === cursor.after);
        if (from >= 0 && after >= from) {
            const window = rows.slice(from);
            return { state: { seq: 1, offset: from, rows: window, tail }, rows: { base: 'resume', keep: after - from + 1, append: rows.slice(after + 1) } };
        }
    }
    return fresh(rows, tail, 1);
}

/** Every later push: the patch from what was sent to what the window holds now; a ledger that moved under it starts over. */
export function nextWindow<R extends WireRow>(state: WindowState<R>, rows: readonly R[]): { state: WindowState<R>; rows: WindowRows<R> } {
    const seq = state.seq + 1;
    // The window no longer starts where it did (the ledger was replaced or trimmed below it): a fresh tail.
    if (rows.length < state.offset || (state.rows.length > 0 && rows[state.offset] !== state.rows[0])) return fresh(rows, state.tail, seq);
    const window = rows.slice(state.offset);
    const max = Math.min(state.rows.length, window.length);
    let keep = 0;
    while (keep < max && state.rows[keep] === window[keep]) keep += 1;
    return { state: { ...state, seq, rows: window }, rows: { base: state.seq, keep, append: window.slice(keep) } };
}

/** The phone's end: what it holds of one agent's window, rebuilt from pushes; `undefined` = a patch it cannot apply. */
export class WindowReceiver<R extends WireRow> {
    #held: { seq: number; rows: readonly R[] } | null = null;
    #lastBase: WindowRows<R>['base'] | undefined;

    apply(seq: number, rows: WindowRows<R>): readonly R[] | undefined {
        let next: readonly R[];
        if (rows.base === null) next = rows.append;
        else if (rows.base === 'resume') {
            if (this.#held === null || rows.keep > this.#held.rows.length) return undefined;
            next = [...this.#held.rows.slice(0, rows.keep), ...rows.append];
        } else {
            if (this.#held === null || this.#held.seq !== rows.base || rows.keep > this.#held.rows.length) return undefined;
            next = rows.keep === this.#held.rows.length && rows.append.length === 0 ? this.#held.rows : [...this.#held.rows.slice(0, rows.keep), ...rows.append];
        }
        this.#held = { seq, rows: next };
        this.#lastBase = rows.base;
        return next;
    }

    rows(): readonly R[] | null {
        return this.#held?.rows ?? null;
    }

    /** What a new connection resumes from: the first row, and the last one before the newest (which may still be growing). */
    cursor(): WindowCursor | null {
        const rows = this.#held?.rows;
        if (!rows || rows.length < 2) return null;
        return { from: rows[0]!.id, after: rows[rows.length - 2]!.id };
    }

    /** How the last push was based — for a test, and for a person debugging what crossed the wire. */
    lastBase(): WindowRows<R>['base'] | undefined {
        return this.#lastBase;
    }

    reset(): void {
        this.#held = null;
    }
}

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

/** An uploaded file's name: its LAST path segment, trimmed; nothing empty, dotted, controlled, overlong or executable. */
export function uploadName(raw: string): { ok: true; name: string } | { ok: false; reason: string } {
    const segments = raw.replace(/\\/g, '/').split('/');
    const name = (segments[segments.length - 1] ?? '').trim();
    if (name.length === 0) return { ok: false, reason: 'the file has no name' };
    if (name === '.' || name === '..') return { ok: false, reason: `"${name}" is not a file name` };
    if (CONTROL.test(name)) return { ok: false, reason: 'the file name has control characters in it' };
    if (name.length > 255) return { ok: false, reason: 'the file name is longer than 255 characters' };
    if (isExecutableName(name)) return { ok: false, reason: `${name} is a natively executable file and is refused` };
    return { ok: true, name };
}

/** A size the upload may declare: more than nothing, no more than `UPLOAD_MAX_BYTES`. */
export function uploadSizeRefusal(name: string, size: number): string | null {
    if (!Number.isFinite(size) || size <= 0) return `${name} is empty`;
    if (size > UPLOAD_MAX_BYTES) return `${name} is ${Math.ceil(size / (1024 * 1024))} MB; the limit is ${UPLOAD_MAX_BYTES / (1024 * 1024)} MB`;
    return null;
}

interface Staged {
    readonly owner: string;
    readonly name: string;
    readonly size: number;
    readonly chunks: Uint8Array[];
    received: number;
    next: number;
    readonly startedAt: number;
}

export type StageResult = { ok: true; id: string } | { ok: false; reason: string };

/** Bytes a connection sent ahead of the call that uses them — in order, size-checked, its own, taken once, dropped when stale. */
export class UploadStaging {
    readonly #now: () => number;
    readonly #staged = new Map<string, Staged>();
    #next = 0;

    constructor(deps: { now: () => number }) {
        this.#now = deps.now;
    }

    begin(owner: string, input: { name: unknown; size: unknown }): StageResult {
        this.#sweep();
        const named = uploadName(typeof input.name === 'string' ? input.name : '');
        if (!named.ok) return named;
        const size = typeof input.size === 'number' ? input.size : NaN;
        const refusal = uploadSizeRefusal(named.name, size);
        if (refusal) return { ok: false, reason: refusal };
        const open = [...this.#staged.values()].filter((s) => s.owner === owner).length;
        if (open >= MAX_OPEN_PER_OWNER) return { ok: false, reason: `only ${MAX_OPEN_PER_OWNER} uploads at a time; finish or drop one first` };
        const id = `up_${++this.#next}_${this.#now().toString(36)}`;
        this.#staged.set(id, { owner, name: named.name, size, chunks: [], received: 0, next: 0, startedAt: this.#now() });
        return { ok: true, id };
    }

    chunk(owner: string, id: string, index: unknown, base64: unknown): { ok: true; received: number } | { ok: false; reason: string } {
        this.#sweep();
        const s = this.#staged.get(id);
        if (!s || s.owner !== owner) return { ok: false, reason: 'no such upload on this connection' };
        if (index !== s.next) return { ok: false, reason: `expected chunk ${s.next}` };
        if (typeof base64 !== 'string') return { ok: false, reason: 'a chunk is base64 text' };
        const bytes = fromBase64(base64);
        if (bytes === null || bytes.byteLength === 0 || bytes.byteLength > UPLOAD_CHUNK_BYTES || s.received + bytes.byteLength > s.size) {
            this.#staged.delete(id);
            return { ok: false, reason: `${s.name}: more bytes than it said it had; the upload was dropped` };
        }
        s.chunks.push(bytes);
        s.received += bytes.byteLength;
        s.next += 1;
        return { ok: true, received: s.received };
    }

    /** The finished upload's name and bytes, ONCE, to the connection that sent it; `null` otherwise. */
    take(owner: string, id: string): { name: string; bytes: Uint8Array } | null {
        this.#sweep();
        const s = this.#staged.get(id);
        if (!s || s.owner !== owner || s.received !== s.size) return null;
        this.#staged.delete(id);
        const bytes = new Uint8Array(s.size);
        let at = 0;
        for (const c of s.chunks) { bytes.set(c, at); at += c.byteLength; }
        return { name: s.name, bytes };
    }

    abort(owner: string, id: string): boolean {
        const s = this.#staged.get(id);
        if (!s || s.owner !== owner) return false;
        return this.#staged.delete(id);
    }

    /** A connection closed: what it staged goes with it. */
    dropOwner(owner: string): void {
        for (const [id, s] of this.#staged) if (s.owner === owner) this.#staged.delete(id);
    }

    #sweep(): void {
        const now = this.#now();
        for (const [id, s] of this.#staged) if (now - s.startedAt > STAGE_TTL_MS) this.#staged.delete(id);
    }
}

/** How many chunks `size` bytes cross as. */
export function chunkCount(size: number): number {
    return Math.max(1, Math.ceil(size / UPLOAD_CHUNK_BYTES));
}

/** Base64 to bytes, in the window and in main alike; `null` for text that is not base64. */
export function fromBase64(text: string): Uint8Array | null {
    try {
        const binary = atob(text);
        const out = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
        return out;
    } catch {
        return null;
    }
}
