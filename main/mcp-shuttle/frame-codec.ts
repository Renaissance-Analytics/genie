/**
 * THE CONTROL CHANNEL'S FRAMING — a 4-byte big-endian byte length, then UTF-8 JSON.
 *
 * genie#346. This is the framing fancy-term-host already proves cross-platform for
 * the pty-host (`encodeFrame` / `FrameDecoder`). The shuttle cannot import it from
 * there: the package's entry loads the native `node-pty`, and the shuttle must ship
 * with no native dependencies. Particle-Academy/fancy-term-host#12 asks for the codec
 * on a dependency-free entry; when it lands, this module becomes a re-export.
 *
 * Both ends of the channel — the shuttle and the Genie publishing into it — use this
 * module, so they cannot disagree about the wire.
 *
 * Structurally the `FrameCodec` the control channel takes.
 */

/** No real control message is anywhere near this; a length beyond it means the
 *  stream is not what it claims to be. Matches fancy-term-host's `MAX_FRAME`. */
export const MAX_FRAME_BYTES = 16 * 1024 * 1024;

const LENGTH_BYTES = 4;

export interface LengthPrefixedDecoder {
    /** Every complete message so far. A body that does not parse is returned as
     *  `undefined` in its place, so the caller can refuse it. */
    push(chunk: Buffer): unknown[];
    /** True once a length prefix exceeded the maximum. Stays true: nothing after a
     *  prefix like that can be trusted to line up. */
    readonly desynced: boolean;
}

export function lengthPrefixedJsonCodec(maxFrameBytes: number = MAX_FRAME_BYTES): {
    encode(message: unknown): Buffer;
    decoder(): LengthPrefixedDecoder;
} {
    return {
        encode(message) {
            const body = Buffer.from(JSON.stringify(message), 'utf8');
            const head = Buffer.alloc(LENGTH_BYTES);
            head.writeUInt32BE(body.length, 0);
            return Buffer.concat([head, body]);
        },

        decoder() {
            let buffer: Buffer = Buffer.alloc(0);
            let desynced = false;
            return {
                get desynced() {
                    return desynced;
                },
                push(chunk) {
                    if (desynced) return [];
                    buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;
                    const out: unknown[] = [];
                    while (buffer.length >= LENGTH_BYTES) {
                        const length = buffer.readUInt32BE(0);
                        if (length > maxFrameBytes) {
                            desynced = true;
                            buffer = Buffer.alloc(0);
                            break;
                        }
                        if (buffer.length < LENGTH_BYTES + length) break;
                        const body = buffer.subarray(LENGTH_BYTES, LENGTH_BYTES + length);
                        buffer = buffer.subarray(LENGTH_BYTES + length);
                        try {
                            out.push(JSON.parse(body.toString('utf8')));
                        } catch {
                            out.push(undefined);
                        }
                    }
                    return out;
                },
            };
        },
    };
}
