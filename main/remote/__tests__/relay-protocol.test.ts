import { describe, it, expect } from 'vitest';
import {
    encodeFrame,
    decodeFrame,
    encodeMemberHello,
    decodeMemberControl,
    encodePopChallenge,
    encodePopProof,
    decodePopChallenge,
    RelayProtocolError,
    type Frame,
} from '../relay-protocol';

describe('frame codec', () => {
    it('round-trips a full frame', () => {
        const f: Frame = {
            kind: 'data',
            channel: 'rest',
            sid: 's1',
            reqId: 'r3',
            payload: { status: 200, body: 'ok' },
        };
        expect(decodeFrame(encodeFrame(f))).toEqual(f);
    });

    it('fails closed on malformed input', () => {
        expect(() => decodeFrame('not json')).toThrow(RelayProtocolError);
        expect(() => decodeFrame(JSON.stringify({ kind: 'data', channel: 'rest' }))).toThrow(
            /missing sid/,
        );
        expect(() => decodeFrame(JSON.stringify({ kind: 'nope', channel: 'rest', sid: 's' }))).toThrow(
            /invalid frame kind/,
        );
        expect(() => decodeFrame(JSON.stringify({ kind: 'data', channel: 'x', sid: 's' }))).toThrow(
            /invalid channel/,
        );
        expect(() =>
            decodeFrame(JSON.stringify({ kind: 'data', channel: 'rest', sid: 's', reqId: 5 })),
        ).toThrow(/invalid reqId/);
    });

    it('accepts a Buffer payload', () => {
        const f = decodeFrame(Buffer.from(encodeFrame({ kind: 'open', channel: 'term', sid: 's' })));
        expect(f.channel).toBe('term');
    });
});

describe('member control', () => {
    it('encodes member-hello', () => {
        expect(JSON.parse(encodeMemberHello('ws-1', 'grant-jws'))).toEqual({
            type: 'member-hello',
            workstationId: 'ws-1',
            grant: 'grant-jws',
        });
    });

    it('decodes member-welcome → sid', () => {
        expect(decodeMemberControl(JSON.stringify({ type: 'member-welcome', sid: 'sid-9' }))).toEqual({
            type: 'member-welcome',
            sid: 'sid-9',
        });
    });

    it('decodes an error control', () => {
        expect(
            decodeMemberControl(JSON.stringify({ type: 'error', code: 'denied', reason: 'bad grant' })),
        ).toEqual({ type: 'error', code: 'denied', reason: 'bad grant' });
    });

    it('fails closed on a welcome without sid / an unknown control', () => {
        expect(() => decodeMemberControl(JSON.stringify({ type: 'member-welcome' }))).toThrow(
            /malformed member-welcome/,
        );
        expect(() => decodeMemberControl(JSON.stringify({ type: 'whatever' }))).toThrow(
            /unexpected control reply/,
        );
        expect(() => decodeMemberControl('{')).toThrow(RelayProtocolError);
    });
});

describe('PoP control (P4.5)', () => {
    const jwk = { kty: 'OKP', crv: 'Ed25519', x: 'abc123' };

    it('encodes a pop-proof as a control data frame', () => {
        expect(JSON.parse(encodePopProof('sid-1', jwk, 'sigb64'))).toEqual({
            kind: 'data',
            channel: 'control',
            sid: 'sid-1',
            payload: { type: 'pop-proof', jwk, sig: 'sigb64' },
        });
    });

    it('encodes a pop-challenge as a control data frame', () => {
        expect(JSON.parse(encodePopChallenge('sid-1', 'the-nonce'))).toEqual({
            kind: 'data',
            channel: 'control',
            sid: 'sid-1',
            payload: { type: 'pop-challenge', nonce: 'the-nonce' },
        });
    });

    it('decodes a valid pop-challenge frame (sid echoed from the frame)', () => {
        const frame = decodeFrame(encodePopChallenge('s', 'n'));
        expect(decodePopChallenge(frame)).toEqual({ sid: 's', nonce: 'n' });
    });

    it('returns null for a non-control frame or another control payload', () => {
        expect(decodePopChallenge({ kind: 'data', channel: 'rest', sid: 's' })).toBeNull();
        expect(
            decodePopChallenge({
                kind: 'data',
                channel: 'control',
                sid: 's',
                payload: { type: 'pop-proof', jwk, sig: 'x' },
            }),
        ).toBeNull();
        expect(
            decodePopChallenge({ kind: 'data', channel: 'control', sid: 's', payload: 'oops' }),
        ).toBeNull();
    });

    it('fails closed on a pop-challenge frame missing its nonce', () => {
        expect(() =>
            decodePopChallenge({
                kind: 'data',
                channel: 'control',
                sid: 's',
                payload: { type: 'pop-challenge' },
            }),
        ).toThrow(/pop-challenge: nonce/);
    });
});
