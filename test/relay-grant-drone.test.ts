import { generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { principalOf, verifyMemberGrant, type TynnJwk } from '../src/main/relay-grant.js';

/**
 * A DRONE ACCEPTS ONLY ITS OWNER'S OWN PAIRED MACHINES (genie#1278 W5; the owner, 2026-10-27: Drones "auto-accept
 * connections from known and paired devices"). What the host is and who is calling both come from the Tynn-signed
 * grant: `aud_role` is what Tynn says THIS workstation is when it minted the grant, `src = owner` that the caller is the
 * owner, and `src_ws` the caller's own registered machine, resolved by Tynn from its device binding. Nothing local.
 * A grant without `aud_role` is treated as a drone's (fail closed).
 */

const key = generateKeyPairSync('ed25519');
const jwk = { ...(key.publicKey.export({ format: 'jwk' }) as { kty: string; crv: string; x: string }), kid: 't1' } as TynnJwk;
const WS = 'ws_target';

function grant(claims: Record<string, unknown>) {
    const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
    const head = b64({ alg: 'EdDSA', typ: 'wsgrant+jwt', kid: 't1' });
    const body = b64({ aud: WS, exp: Math.floor(Date.now() / 1000) + 300, jti: 'g', sub: 'u1', cap: 'control', scope: ['host:all'], ...claims });
    const token = `${head}.${body}.${sign(null, Buffer.from(`${head}.${body}`), key.privateKey).toString('base64url')}`;
    const checked = verifyMemberGrant(token, { keys: [jwk], workstationId: WS });
    if (!checked.ok) throw new Error(checked.reason);
    return checked.grant;
}

describe('the grant says what this host is and who is calling', () => {
    it('reads aud_role and src_ws from the signed claims', () => {
        const g = grant({ src: 'owner', src_ws: 'ws_pilot', aud_role: 'drone' });
        expect(g.audRole).toBe('drone');
        expect(g.sourceWorkstationId).toBe('ws_pilot');
    });

    it('anything but exactly "pilot" reads as drone', () => {
        for (const audRole of [undefined, 'PILOT', 'pilot ', true, 'admin']) {
            expect(grant({ aud_role: audRole }).audRole).toBe('drone');
        }
        expect(grant({ aud_role: 'pilot' }).audRole).toBe('pilot');
    });
});

describe('a drone host admits only the owner, from one of the owner\'s own paired machines', () => {
    it('admits the owner from a paired machine (positive control)', () => {
        expect(principalOf(grant({ src: 'owner', src_ws: 'ws_pilot', aud_role: 'drone' }))).toMatchObject({ ok: true, principal: { isOwner: true } });
    });

    it('refuses the owner with no paired machine behind the grant (a browser, an unbound pairing)', () => {
        const r = principalOf(grant({ src: 'owner', aud_role: 'drone' }));
        expect(r.ok).toBe(false);
        expect((r as { reason: string }).reason).toMatch(/drone/);
    });

    it('refuses every guest — a share, an invite, a grant — whatever its scope', () => {
        for (const src of ['grant', 'invite', 'share']) {
            for (const scope of [['host:all'], ['workspace:design']]) {
                expect(principalOf(grant({ src, src_ws: 'ws_other', scope, aud_role: 'drone' })).ok).toBe(false);
            }
        }
    });

    it('a grant that does not say the host is a pilot is judged as a drone\'s', () => {
        expect(principalOf(grant({ src: 'invite', scope: ['workspace:design'] })).ok).toBe(false);
        expect(principalOf(grant({ src: 'owner' })).ok).toBe(false);
        expect(principalOf(grant({ src: 'owner', src_ws: 'ws_pilot' })).ok).toBe(true);
    });

    it('a PILOT host keeps today\'s rules: the owner from anywhere, a guest scoped by its grant (CONTROL)', () => {
        expect(principalOf(grant({ src: 'owner', aud_role: 'pilot' }))).toMatchObject({ ok: true, principal: { isOwner: true } });
        expect(principalOf(grant({ src: 'invite', scope: ['workspace:design'], aud_role: 'pilot' }))).toMatchObject({ ok: true, principal: { isOwner: false, workspaceId: 'design' } });
    });
});
