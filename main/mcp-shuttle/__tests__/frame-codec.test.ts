import { describe, expect, it } from 'vitest';
import { MAX_FRAME_BYTES, lengthPrefixedJsonCodec } from '../frame-codec';

/**
 * THE CONTROL CHANNEL'S FRAMING — 4-byte big-endian length, then UTF-8 JSON.
 *
 * genie#346. The same framing fancy-term-host proves cross-platform for the pty-host
 * (`encodeFrame` / `FrameDecoder`). That package cannot be imported by the shuttle —
 * its entry loads the native `node-pty`, and the shuttle ships with no native
 * dependencies — until Particle-Academy/fancy-term-host#12 exposes the codec on its
 * own. Both ends of THIS channel (the shuttle and Genie) use this module, so they
 * cannot disagree on the wire; when #12 lands this becomes a re-export.
 *
 * A stream has no message boundaries, so the decoder is the part that matters: it
 * must hold a partial frame, split several, refuse a malformed body without losing
 * its place, and give up on a stream whose length prefix cannot be real.
 */

const codec = lengthPrefixedJsonCodec();

describe('encode', () => {
    it('prefixes the JSON body with its byte length, big-endian', () => {
        const frame = codec.encode({ a: 'é' }); // é is two bytes: length is BYTES, not chars
        const body = Buffer.from(JSON.stringify({ a: 'é' }), 'utf8');
        expect(frame.readUInt32BE(0)).toBe(body.length);
        expect(frame.subarray(4).equals(body)).toBe(true);
    });
});

describe('decode', () => {
    it('round-trips a message', () => {
        expect(codec.decoder().push(codec.encode({ type: 'hello', n: 1 }))).toEqual([{ type: 'hello', n: 1 }]);
    });

    it('holds a partial frame until the rest arrives, byte by byte', () => {
        const d = codec.decoder();
        const frame = codec.encode({ type: 'result', correlationId: 7 });
        const out: unknown[] = [];
        for (const byte of frame) out.push(...d.push(Buffer.from([byte])));
        expect(out).toEqual([{ type: 'result', correlationId: 7 }]);
    });

    it('splits several frames that arrive in one chunk', () => {
        const d = codec.decoder();
        const chunk = Buffer.concat([codec.encode({ n: 1 }), codec.encode({ n: 2 }), codec.encode({ n: 3 })]);
        expect(d.push(chunk)).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
    });

    it('returns an unparseable body as undefined, in its place, and keeps going', () => {
        // The server refuses that connection; the decoder must not have swallowed
        // it silently, nor lost the frames around it.
        const d = codec.decoder();
        const bad = Buffer.from('{ not json', 'utf8');
        const head = Buffer.alloc(4);
        head.writeUInt32BE(bad.length, 0);
        const chunk = Buffer.concat([codec.encode({ n: 1 }), head, bad, codec.encode({ n: 2 })]);
        expect(d.push(chunk)).toEqual([{ n: 1 }, undefined, { n: 2 }]);
        expect(d.desynced).toBe(false);
    });

    it('gives up on a length prefix no real frame could have', () => {
        const d = codec.decoder();
        const head = Buffer.alloc(4);
        head.writeUInt32BE(MAX_FRAME_BYTES + 1, 0);
        expect(d.push(head)).toEqual([]);
        expect(d.desynced).toBe(true);
    });

    it('POSITIVE CONTROL — a frame of exactly the maximum size is still a frame', () => {
        const d = lengthPrefixedJsonCodec(64).decoder();
        const body = Buffer.from(JSON.stringify('x'.repeat(62)), 'utf8'); // 64 bytes with quotes
        expect(body.length).toBe(64);
        const head = Buffer.alloc(4);
        head.writeUInt32BE(64, 0);
        expect(d.push(Buffer.concat([head, body]))).toEqual(['x'.repeat(62)]);
        expect(d.desynced).toBe(false);
    });

    it('stays desynced — nothing after a bad prefix is trusted', () => {
        const d = lengthPrefixedJsonCodec(16).decoder();
        const head = Buffer.alloc(4);
        head.writeUInt32BE(1_000, 0);
        d.push(head);
        expect(d.push(codec.encode({ n: 1 }))).toEqual([]);
        expect(d.desynced).toBe(true);
    });

    it('keeps one decoder’s partial frame out of another’s', () => {
        const a = codec.decoder();
        const b = codec.decoder();
        const frame = codec.encode({ who: 'a' });
        a.push(frame.subarray(0, 3));
        expect(b.push(codec.encode({ who: 'b' }))).toEqual([{ who: 'b' }]);
        expect(a.push(frame.subarray(3))).toEqual([{ who: 'a' }]);
    });
});
