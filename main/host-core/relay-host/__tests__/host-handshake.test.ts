import { createPrivateKey, generateKeyPairSync, sign, verify } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { PopKeypair } from '../../../remote/relay-pop';
import { acceptSiteKey, completeSiteKey, initiateSiteKey } from '../../../remote/site-e2e';
import { buildTicketHostHello, hostHelloSigningString } from '../hello';
import { jwkThumbprint, popDecision, verifyPopProof } from '../pop';
import { loopbackTarget } from '../proxy-paths';

/**
 * The host half of the relay handshake, on a desktop (genie#680). Each piece must
 * agree byte-for-byte with its other half, which already ships: the member's
 * PoP signer and site-E2E initiator (`main/remote/*`), and genie-cloud's relay
 * ticket verifier (`createTynnEnrollmentVerifier`). So every test here drives the
 * real counterpart rather than a reimplementation of it.
 */

describe('proof of possession (host side)', () => {
    const grant = (over: Partial<{ capability: 'control' | 'readonly'; confirmationKeyThumbprint: string }> = {}) => ({
        capability: 'control' as const,
        ...over,
    });

    it('admits a member that signs the challenge with the key its grant is bound to', () => {
        const member = PopKeypair.generate();
        const proof = member.prove('nonce-1', 'ws-desktop', 'sid-1');

        expect(
            verifyPopProof({ jwk: proof.jwk, signatureB64u: proof.sig, nonce: 'nonce-1', workstationId: 'ws-desktop', sid: 'sid-1', expectedThumbprint: jwkThumbprint(member.publicJwk) }),
        ).toEqual({ verified: true });
    });

    it('refuses a proof from another key, for another session, or over another nonce', () => {
        const member = PopKeypair.generate();
        const thief = PopKeypair.generate();
        const bound = jwkThumbprint(member.publicJwk);
        const good = member.prove('nonce-1', 'ws-desktop', 'sid-1');
        const stolen = thief.prove('nonce-1', 'ws-desktop', 'sid-1');

        expect(verifyPopProof({ jwk: stolen.jwk, signatureB64u: stolen.sig, nonce: 'nonce-1', workstationId: 'ws-desktop', sid: 'sid-1', expectedThumbprint: bound }).verified).toBe(false);
        expect(verifyPopProof({ jwk: good.jwk, signatureB64u: good.sig, nonce: 'nonce-1', workstationId: 'ws-desktop', sid: 'sid-2', expectedThumbprint: bound }).verified).toBe(false);
        expect(verifyPopProof({ jwk: good.jwk, signatureB64u: good.sig, nonce: 'nonce-2', workstationId: 'ws-desktop', sid: 'sid-1', expectedThumbprint: bound }).verified).toBe(false);
        expect(verifyPopProof({ jwk: { kty: 'RSA' }, signatureB64u: good.sig, nonce: 'nonce-1', workstationId: 'ws-desktop', sid: 'sid-1', expectedThumbprint: bound }).verified).toBe(false);
        expect(verifyPopProof({ jwk: good.jwk, signatureB64u: '', nonce: 'nonce-1', workstationId: 'ws-desktop', sid: 'sid-1', expectedThumbprint: bound }).verified).toBe(false);
    });

    it('challenges a bound grant, refuses an unbound control grant, lets an unbound read-only grant through', () => {
        expect(popDecision(grant({ confirmationKeyThumbprint: 't' }))).toBe('challenge');
        expect(popDecision(grant({ capability: 'readonly', confirmationKeyThumbprint: 't' }))).toBe('challenge');
        expect(popDecision(grant())).toBe('reject');
        expect(popDecision(grant({ capability: 'readonly' }))).toBe('skip');
    });
});

describe('site end-to-end key (host side)', () => {
    it('agrees a cipher the member can complete, proving it is the host the grant pinned', () => {
        const host = generateKeyPairSync('ed25519');
        const hostPublicKeyB64 = (host.publicKey.export({ type: 'spki', format: 'der' }) as Buffer).toString('base64');
        const { init, pending } = initiateSiteKey();

        const { accept, cipher: hostCipher } = acceptSiteKey(init, {
            sid: 'sid-1',
            workstationId: 'ws-desktop',
            sign: (data) => sign(null, data, host.privateKey),
        });
        const memberCipher = completeSiteKey(pending, accept, { sid: 'sid-1', workstationId: 'ws-desktop', hostPublicKeyB64 });

        const sealed = memberCipher.seal({ kind: 'data', channel: 'site', sid: 'sid-1', reqId: 'r1', payload: { hello: 'site' } });
        expect(hostCipher.open(sealed).payload).toEqual({ hello: 'site' });
        const back = hostCipher.seal({ kind: 'data', channel: 'site', sid: 'sid-1', reqId: 'r1', payload: { ok: true } });
        expect(memberCipher.open(back).payload).toEqual({ ok: true });
    });

    it('is refused by a member that pinned a different host', () => {
        const host = generateKeyPairSync('ed25519');
        const impostorPinned = (generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'der' }) as Buffer).toString('base64');
        const { init, pending } = initiateSiteKey();

        const { accept } = acceptSiteKey(init, { sid: 'sid-1', workstationId: 'ws-desktop', sign: (data) => sign(null, data, host.privateKey) });

        expect(() => completeSiteKey(pending, accept, { sid: 'sid-1', workstationId: 'ws-desktop', hostPublicKeyB64: impostorPinned })).toThrow(/signature/);
    });
});

describe('relay ticket hello', () => {
    it('signs the claim under the domain genie-cloud\'s relay verifies, with the host key', () => {
        const host = generateKeyPairSync('ed25519');
        const pem = host.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

        const hello = buildTicketHostHello({
            ticket: 'the.ticket.jws',
            workstationId: 'ws-desktop',
            fingerprint: 'fp',
            sign: (data) => sign(null, data, createPrivateKey(pem)),
            now: 1234,
        });

        expect(hello).toMatchObject({ type: 'host-hello', workstationId: 'ws-desktop', fingerprint: 'fp', ts: 1234, ticket: 'the.ticket.jws' });
        expect(hello.nonce).toMatch(/^[0-9a-f]{32}$/);
        // The exact string genie-cloud's createTynnEnrollmentVerifier checks.
        expect(hostHelloSigningString(hello)).toBe(`genie-relay-host-hello\nws-desktop.fp.${hello.nonce}.1234`);
        expect(verify(null, Buffer.from(hostHelloSigningString(hello), 'utf8'), host.publicKey, Buffer.from(hello.sig, 'base64url'))).toBe(true);
    });
});

describe('what a relay member may reach on this machine\'s local server', () => {
    it.each([
        ['rest', '/api/state', '/api/state'],
        ['rest', '/api/files/read?x=1', '/api/files/read?x=1'],
        ['events', '/ws/events', '/ws/events'],
        ['term', '/ws/term?terminal=t-1&client=desktop', '/ws/term?terminal=t-1&client=desktop'],
        ['site', '/api/site/site-1/index.html', '/api/site/site-1/index.html'],
    ] as const)('%s %s', (channel, path, expected) => {
        expect(loopbackTarget(channel, path)).toBe(expected);
    });

    it.each([
        ['rest', '/api/pair'],
        ['rest', '/m/'],
        ['rest', 'http://169.254.169.254/latest'],
        ['rest', '//evil.example/api/state'],
        ['rest', '/api/../m/'],
        ['rest', '/api/site/x'],
        ['events', '/ws/term?terminal=t-1'],
        ['term', '/ws/events'],
        ['term', '/api/state'],
        ['site', '/api/state'],
        ['rest', ''],
    ] as const)('refuses %s %s', (channel, path) => {
        expect(loopbackTarget(channel, path)).toBeNull();
    });
});
