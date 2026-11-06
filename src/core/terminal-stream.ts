/** Terminal stream offsets count UTF-16 code units, including lone surrogates. */
export const TERMINAL_CHUNK_BYTES = 256 * 1024;
export const TERMINAL_QUEUE_BYTES = 4 * 1024 * 1024;

export interface TerminalPosition { readonly epoch: string; readonly endOffset: number }
export interface TerminalDataPosition extends TerminalPosition { readonly offset: number }
export interface TerminalStreamSnapshot {
    readonly id: string;
    readonly tail: string;
    readonly epoch: string | null;
    readonly endOffset: number | null;
}
export interface TerminalTextChunk {
    readonly data: string;
    readonly offset: number;
    /** UTF-8 bytes in the JSON string body; conservatively bounds escaped controls too. */
    readonly bytes: number;
}

export const isTerminalOffset = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

export function terminalPosition(value: unknown): TerminalPosition | null {
    if (!value || typeof value !== 'object') return null;
    const v = value as Record<string, unknown>;
    return typeof v['epoch'] === 'string' && v['epoch'].length > 0 && isTerminalOffset(v['endOffset'])
        ? { epoch: v['epoch'], endOffset: v['endOffset'] } : null;
}

export function terminalDataPosition(value: unknown, data: string): TerminalDataPosition | null {
    if (!value || typeof value !== 'object') return null;
    const v = value as Record<string, unknown>, offset = v['offset'];
    if (typeof v['epoch'] !== 'string' || !v['epoch'] || !isTerminalOffset(offset) || !isTerminalOffset(offset + data.length)) return null;
    const endOffset = offset + data.length;
    if (v['endOffset'] !== undefined && v['endOffset'] !== endOffset) return null;
    return { epoch: v['epoch'], offset, endOffset };
}

/** Lazy: a blocked write retains its original string without materializing the remaining chunks. */
export function* splitTerminalText(text: string, startOffset = 0): Generator<TerminalTextChunk> {
    let start = 0, at = 0, bytes = 0;
    while (at < text.length) {
        const code = text.charCodeAt(at), next = text.charCodeAt(at + 1);
        const pair = code >= 0xd800 && code <= 0xdbff && next >= 0xdc00 && next <= 0xdfff;
        const width = pair ? 2 : 1;
        const cost = pair ? 4 : code >= 0xd800 && code <= 0xdfff ? 6
            : code === 34 || code === 92 || code === 8 || code === 9 || code === 10 || code === 12 || code === 13 ? 2
            : code < 32 ? 6 : code < 128 ? 1 : code < 2048 ? 2 : 3;
        if (bytes + cost > TERMINAL_CHUNK_BYTES) {
            yield { data: text.slice(start, at), offset: startOffset + start, bytes };
            start = at; bytes = 0;
        }
        bytes += cost; at += width;
    }
    if (start < text.length || text.length === 0) yield { data: text.slice(start), offset: startOffset + start, bytes };
}

/** Owned by the process observing the pty from creation, never reconstructed from a bounded tail. */
export class TerminalOutputCounter {
    readonly #epoch: string;
    #endOffset = 0;
    constructor(epoch: string) { this.#epoch = epoch; }
    append(data: string): TerminalDataPosition {
        const offset = this.#endOffset;
        if (!isTerminalOffset(offset + data.length)) throw new Error('terminal output position is no longer representable');
        this.#endOffset += data.length;
        return { epoch: this.#epoch, offset, endOffset: this.#endOffset };
    }
    snapshot(): TerminalPosition { return { epoch: this.#epoch, endOffset: this.#endOffset }; }
}

type StreamResult = { kind: 'resync'; reason: string } | { kind: 'ignored' } | { kind: 'attached' | 'data'; data: string } | { kind: 'exit'; exitCode: number };

/** Tail-to-live handoff: duplicates are harmless; gaps and unknown producer epochs are explicit. */
export class TerminalStreamReceiver {
    #position: TerminalPosition | null = null;
    #ended = false;
    snapshot(): { epoch: string | null; expectedOffset: number | null } {
        return { epoch: this.#position?.epoch ?? null, expectedOffset: this.#position?.endOffset ?? null };
    }
    attach(value: unknown): StreamResult {
        this.#position = null; this.#ended = false;
        const position = terminalPosition(value), tail = (value as { tail?: unknown } | null)?.tail;
        if (!position || typeof tail !== 'string' || position.endOffset < tail.length) return { kind: 'resync', reason: 'terminal producer position is unknown; attach again' };
        this.#position = position;
        return { kind: 'attached', data: tail };
    }
    data(value: unknown): StreamResult {
        const data = (value as { data?: unknown } | null)?.data;
        const incoming = typeof data === 'string' ? terminalDataPosition(value, data) : null, held = this.#position;
        if (!incoming || !held || this.#ended || incoming.epoch !== held.epoch || incoming.offset > held.endOffset) return { kind: 'resync', reason: 'terminal output has a gap or a different producer; attach again' };
        if (incoming.endOffset <= held.endOffset) return { kind: 'ignored' };
        const suffix = (data as string).slice(held.endOffset - incoming.offset);
        this.#position = { epoch: incoming.epoch, endOffset: incoming.endOffset };
        return { kind: 'data', data: suffix };
    }
    exit(value: unknown): StreamResult {
        const end = terminalPosition(value), code = (value as { exitCode?: unknown } | null)?.exitCode;
        if (!end || !this.#position || end.epoch !== this.#position.epoch || end.endOffset !== this.#position.endOffset || typeof code !== 'number') return { kind: 'resync', reason: 'terminal exit precedes missing output; attach again' };
        this.#ended = true;
        return { kind: 'exit', exitCode: code };
    }
}
