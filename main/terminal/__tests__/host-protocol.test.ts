import { describe, expect, it } from 'vitest';
import {
    encodeFrame,
    FrameDecoder,
    PROTOCOL_VERSION,
    type ClientMessage,
    type HostMessage,
} from '../host-protocol';

/**
 * Tier 3 — pty-host wire protocol. The framing is the foundation both the host
 * and the client depend on, so it's tested in isolation: encode → decode must
 * round-trip every message, the decoder must reassemble messages split across
 * chunks (and split MID-frame), and a realistic create→data→exit sequence must
 * come back in order.
 */

describe('frame round-trip', () => {
    it('encodes + decodes a single message', () => {
        const msg: ClientMessage = {
            kind: 'create',
            seq: 1,
            opts: { id: 't1', cwd: '/tmp', shell: '/bin/bash', args: ['-l'] },
        };
        const dec = new FrameDecoder();
        const out = dec.push(encodeFrame(msg));
        expect(out).toHaveLength(1);
        expect(out[0]).toEqual(msg);
    });

    it('reassembles a message split across multiple chunks', () => {
        const msg: HostMessage = { kind: 'data', id: 't1', data: 'hello world' };
        const frame = encodeFrame(msg);
        const dec = new FrameDecoder();
        // Feed the frame one byte at a time — nothing emits until it's whole.
        let emitted: unknown[] = [];
        for (let i = 0; i < frame.length; i++) {
            emitted = emitted.concat(dec.push(frame.subarray(i, i + 1)));
        }
        expect(emitted).toHaveLength(1);
        expect(emitted[0]).toEqual(msg);
    });

    it('emits multiple messages from one combined chunk', () => {
        const a: ClientMessage = { kind: 'ping', seq: 1 };
        const b: ClientMessage = { kind: 'kill', id: 'x' };
        const c: ClientMessage = { kind: 'write', id: 'x', data: 'ls\n' };
        const combined = Buffer.concat([encodeFrame(a), encodeFrame(b), encodeFrame(c)]);
        const dec = new FrameDecoder();
        const out = dec.push(combined);
        expect(out).toEqual([a, b, c]);
    });

    it('replays a create → data → exit sequence in order', () => {
        const seq: HostMessage[] = [
            {
                kind: 'created',
                seq: 5,
                result: {
                    id: 't1',
                    pid: 4321,
                    shell: '/bin/bash',
                    existing: false,
                    scrollback: '',
                },
            },
            { kind: 'data', id: 't1', data: '$ echo hi\r\n' },
            { kind: 'data', id: 't1', data: 'hi\r\n' },
            { kind: 'exit', id: 't1', exitCode: 0 },
        ];
        const wire = Buffer.concat(seq.map(encodeFrame));
        const dec = new FrameDecoder();
        const out = dec.push(wire) as HostMessage[];
        expect(out).toEqual(seq);
    });

    it('skips a corrupt frame body without wedging the stream', () => {
        // Hand-build a frame with a valid length prefix but non-JSON body,
        // followed by a valid frame. The corrupt one is dropped; the good one
        // still decodes.
        const garbage = Buffer.from('not json{', 'utf8');
        const header = Buffer.allocUnsafe(4);
        header.writeUInt32BE(garbage.length, 0);
        const good = encodeFrame({ kind: 'pong', seq: 9 });
        const dec = new FrameDecoder();
        const out = dec.push(Buffer.concat([header, garbage, good]));
        expect(out).toEqual([{ kind: 'pong', seq: 9 }]);
        expect(dec.desynced).toBe(false);
    });

    it('flags desync on an absurd length prefix', () => {
        const header = Buffer.allocUnsafe(4);
        header.writeUInt32BE(FrameDecoder.MAX_FRAME + 1, 0);
        const dec = new FrameDecoder();
        const out = dec.push(header);
        expect(out).toHaveLength(0);
        expect(dec.desynced).toBe(true);
    });

    it('exposes a stable protocol version', () => {
        expect(typeof PROTOCOL_VERSION).toBe('number');
        expect(PROTOCOL_VERSION).toBeGreaterThanOrEqual(1);
    });
});
