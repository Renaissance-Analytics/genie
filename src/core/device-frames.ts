/**
 * A FRAME TO OR FROM ANOTHER MACHINE, IN PIECES (Tynn #941, client/host split step 2f-2). A remote window's connection to
 * another machine is genie-host's device link, reached over the window's own protocol connection. That connection's door
 * caps one frame at 1 MiB (core/local-frame.ts LOCAL_FRAME_LIMIT_BYTES); another machine's frames reach 100 MiB
 * (device-link-service.ts DEVICE_FRAME_LIMIT_BYTES): an agent's whole history, a large snapshot. So a frame crosses the
 * door in pieces, both ways, each marked `more` until the last, and is joined whole before anyone reads it.
 *
 * A piece is counted in characters, and is small enough that its worst JSON escaping (a control character is six bytes,
 * `\u0001`) still fits one door frame with its envelope: 128 Ki characters is at most 768 KiB escaped.
 */
export const DEVICE_PIECE_CHARS = 128 * 1024;

/** The frame cut into pieces of at most DEVICE_PIECE_CHARS characters, in order; an empty frame is one empty piece. */
export function framePieces(text: string): string[] {
    if (text.length <= DEVICE_PIECE_CHARS) return [text];
    const pieces: string[] = [];
    for (let at = 0; at < text.length; at += DEVICE_PIECE_CHARS) pieces.push(text.slice(at, at + DEVICE_PIECE_CHARS));
    return pieces;
}

/**
 * Pieces joined back into frames, by key (a channel, or an owner's channel): each key's pieces stay apart, and a whole
 * frame comes back once, when its last piece arrives. Past `limitChars` the frame is refused and forgotten: the next piece
 * for that key starts a new frame.
 */
export class FrameJoiner {
    readonly #limit: number;
    readonly #held = new Map<string, { parts: string[]; size: number }>();

    constructor(limitChars: number) { this.#limit = limitChars; }

    /** A piece for `key`: the whole frame when this was its last piece, `null` while more are to come. */
    add(key: string, piece: string, more: boolean): { ok: true; text: string } | { ok: false; reason: string } | null {
        const held = this.#held.get(key) ?? { parts: [], size: 0 };
        held.parts.push(piece);
        held.size += piece.length;
        if (held.size > this.#limit) {
            this.#held.delete(key);
            return { ok: false, reason: `a frame larger than ${this.#limit} characters, the most this connection carries in one piece` };
        }
        if (more) { this.#held.set(key, held); return null; }
        this.#held.delete(key);
        return { ok: true, text: held.parts.length === 1 ? held.parts[0]! : held.parts.join('') };
    }

    /** Forget what `key` had half-sent (its channel closed). */
    drop(key: string): void { this.#held.delete(key); }

    /** Forget every key `prefix` begins (an owner left). */
    dropPrefix(prefix: string): void { for (const key of [...this.#held.keys()]) if (key.startsWith(prefix)) this.#held.delete(key); }
}
