import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { grantAccessPolicy, verifyMemberGrant, type TynnJwk } from '../grant';

/**
 * The desktop relay host's check on a member's connection grant (genie#680): the
 * Ed25519 JWS Tynn mints at connect, verified OFFLINE against Tynn's published
 * keys — the same contract genie-cloud's `verifyGrantJws` enforces, mirrored here
 * because a desktop is now a relay host too.
 *
 * What a grant earns on this machine is decided by what it says, and by nothing a
 * member can add: the audience must be THIS workstation, the scope and capability
 * must be well-formed, and a Tynn MEMBER grant is the only token type accepted (a
 * relay ticket, signed by the same key, is not one).
 */

const b64u = (v: string | Buffer) => Buffer.from(v).toString('base64url');

function tynnKey(kid = 'tynn-1'): { jwk: TynnJwk; privateKey: KeyObject } {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    return { jwk: { kty: 'OKP', crv: 'Ed25519', kid, x: publicKey.export({ format: 'jwk' }).x as string }, privateKey };
}

const NOW = 1_800_000_000_000;
const nowSec = Math.floor(NOW / 1000);

function grant(
    key: { jwk: TynnJwk; privateKey: KeyObject },
    claims: Record<string, unknown> = {},
    header: Record<string, unknown> = {},
): string {
    const input = `${b64u(JSON.stringify({ alg: 'EdDSA', typ: 'wsgrant+jwt', kid: key.jwk.kid, ...header }))}.${b64u(
        JSON.stringify({
            iss: 'https://tynn.ai',
            sub: 'user-sam',
            aud: 'ws-desktop',
            cap: 'control',
            scope: ['workspace:ws-app'],
            sites: { 'site-app': 'interact' },
            jti: 'grant-1',
            iat: nowSec,
            nbf: nowSec,
            exp: nowSec + 900,
            name: 'Sam Support',
            src: 'share',
            cnf: { jkt: 'thumb-1' },
            ...claims,
        }),
    )}`;
    return `${input}.${b64u(sign(null, Buffer.from(input), key.privateKey))}`;
}

const verify = (token: string, keys: TynnJwk[]) => verifyMemberGrant(token, { keys, workstationId: 'ws-desktop', now: NOW });

describe('verifyMemberGrant', () => {
    it('maps a valid grant to who it is for and what it reaches', () => {
        const key = tynnKey();

        expect(verify(grant(key), [key.jwk])).toEqual({
            ok: true,
            grant: {
                jti: 'grant-1',
                sub: 'user-sam',
                name: 'Sam Support',
                source: 'share',
                capability: 'control',
                scopes: ['workspace:ws-app'],
                sitePermissions: { 'site-app': 'interact' },
                expiresAt: (nowSec + 900) * 1000,
                confirmationKeyThumbprint: 'thumb-1',
            },
        });
    });

    it('refuses a grant for another workstation', () => {
        const key = tynnKey();

        const r = verify(grant(key, { aud: 'ws-somebody-else' }), [key.jwk]);
        expect(r.ok).toBe(false);
        expect(r.ok ? '' : r.reason).toMatch(/audience/);
    });

    it('refuses a grant not signed by Tynn, or by a key it does not know', () => {
        const key = tynnKey();

        expect(verify(grant(tynnKey('tynn-1')), [key.jwk]).ok).toBe(false);
        expect(verify(grant(tynnKey('other')), [key.jwk]).ok).toBe(false);
    });

    it('refuses a relay ticket, signed by the same key', () => {
        const key = tynnKey();
        const ticket = grant(key, { aud: 'genie-relay', sub: 'ws-desktop', cap: undefined, scope: undefined }, { typ: 'wsrelay+jwt' });

        expect(verify(ticket, [key.jwk]).ok).toBe(false);
    });

    it('refuses expired and not-yet-valid grants', () => {
        const key = tynnKey();

        expect(verify(grant(key, { exp: nowSec - 600 }), [key.jwk]).ok).toBe(false);
        expect(verify(grant(key, { nbf: nowSec + 600 }), [key.jwk]).ok).toBe(false);
    });

    it('refuses a malformed scope, capability or site permission', () => {
        const key = tynnKey();

        expect(verify(grant(key, { scope: ['workspace:'] }), [key.jwk]).ok).toBe(false);
        expect(verify(grant(key, { scope: ['everything'] }), [key.jwk]).ok).toBe(false);
        expect(verify(grant(key, { scope: [] }), [key.jwk]).ok).toBe(false);
        expect(verify(grant(key, { cap: 'admin' }), [key.jwk]).ok).toBe(false);
        expect(verify(grant(key, { sites: { 'site-app': 'own' } }), [key.jwk]).ok).toBe(false);
        expect(verify(grant(key, { sites: ['site-app'] }), [key.jwk]).ok).toBe(false);
        expect(verify(grant(key, { jti: '' }), [key.jwk]).ok).toBe(false);
    });

    it('refuses a token that is not a compact JWS, or uses another algorithm', () => {
        const key = tynnKey();

        expect(verify('not-a-jws', [key.jwk]).ok).toBe(false);
        expect(verify(`${b64u('{')}.${b64u('{}')}.x`, [key.jwk]).ok).toBe(false);
        expect(verify(grant(key, {}, { alg: 'HS256' }), [key.jwk]).ok).toBe(false);
    });

    it('treats a grant with no name or source as a nameless guest (an older Tynn)', () => {
        const key = tynnKey();

        const r = verify(grant(key, { name: undefined, src: undefined }), [key.jwk]);
        expect(r.ok && r.grant.name).toBeNull();
        expect(r.ok && r.grant.source).toBeNull();
    });
});

describe('grantAccessPolicy', () => {
    it('turns a grant into the policy its guest session is judged by, over the Tynn transport only', () => {
        const key = tynnKey();
        const r = verify(grant(key), [key.jwk]);
        if (!r.ok) throw new Error(r.reason);

        expect(grantAccessPolicy(r.grant)).toEqual({
            principalId: 'user-sam',
            principalType: 'tynn-user',
            transports: ['tynn'],
            capability: 'control',
            workspaceScopes: ['workspace:ws-app'],
            sitePermissions: { 'site-app': 'interact' },
        });
    });
});
