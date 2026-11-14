/**
 * NO FRAME A REMOTE CONNECTION CANNOT TAKE (Tynn #579). The tailnet transport closes a connection on a frame over 1 MiB, the
 * Tynn relay has its own limit, and a whole features snapshot can be larger than either. Everything the host sends to
 * another device passes through here: a frame over the cap is a refusal (a result) or is not sent (an event), never a
 * frame that ends the connection.
 */

/** The most one frame to another device may be: half the tailnet's 1 MiB, so the envelope and a relay's framing fit. */
export const REMOTE_FRAME_MAX_BYTES = 512 * 1024;

export const FRAME_TOO_LARGE = 'this is too large to send to another device; use the host’s own screen';

/** What to send for `text`: itself when it fits; a refusal for the same call when it is a result; `null` (send nothing) otherwise. */
export function fitRemoteFrame(text: string, max: number = REMOTE_FRAME_MAX_BYTES): { text: string | null } {
    if (Buffer.byteLength(text) <= max) return { text };
    try {
        const frame = JSON.parse(text) as { kind?: unknown; id?: unknown };
        if (frame.kind === 'result' && typeof frame.id === 'number') return { text: JSON.stringify({ kind: 'result', id: frame.id, ok: false, reason: FRAME_TOO_LARGE }) };
    } catch { /* not JSON: nothing to answer */ }
    return { text: null };
}

/** A `features` push that carries only the revision: the snapshot was too large to send, and is read instead. */
export function isFeaturesRevision(payload: unknown): payload is { revision: number } {
    if (typeof payload !== 'object' || payload === null) return false;
    const keys = Object.keys(payload);
    return keys.length === 1 && keys[0] === 'revision' && typeof (payload as { revision: unknown }).revision === 'number';
}
