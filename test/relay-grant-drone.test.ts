import { generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { principalOf, verifyMemberGrant, type TynnJwk } from '../src/main/relay-grant.js';

/**
 * A DRONE ACCEPTS ONLY ITS OWNER'S OWN PAIRED MACHINES, AND SHARE LINKS (genie#1278 W5; the owner, 2026-10-27: Drones
 * "auto-accept connections from known and paired devices"; 2026-10-28: "allow share links" — a guest holding a valid
 * share link, and nothing beyond that link's scope). What the host is and who is calling both come from the Tynn-signed
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

    it('reads share_origin from the signed claims; anything but a known origin is none', () => {
        expect(grant({ src: 'share', share_origin: 'link' }).shareOrigin).toBe('link');
        expect(grant({ src: 'share', share_origin: 'member' }).shareOrigin).toBe('member');
        expect(grant({ src: 'share', share_origin: 'invite' }).shareOrigin).toBe('invite');
        for (const v of [undefined, 'LINK', 'link ', true, 'owner']) expect(grant({ src: 'share', share_origin: v }).shareOrigin).toBeNull();
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

    it('admits a SHARE LINK guest, as a guest, inside the link\'s scope only (owner 2026-10-28: "links only")', () => {
        const link = { src: 'share', share_origin: 'link', aud_role: 'drone' };
        // One workspace: a guest of that workspace, never the owner, never the host.
        expect(principalOf(grant({ ...link, scope: ['workspace:design'], cap: 'readonly' })))
            .toEqual({ ok: true, principal: { label: 'u1', isOwner: false, workspaceId: 'design', readonly: true } });
        // A whole-workstation link: a guest of the whole host, still not the owner.
        expect(principalOf(grant({ ...link, scope: ['host:all'] })))
            .toEqual({ ok: true, principal: { label: 'u1', isOwner: false, workspaceId: null, readonly: false } });
        // A link naming several workspaces is refused in words, as on a pilot (never widened).
        expect(principalOf(grant({ ...link, scope: ['workspace:a', 'workspace:b'] })).ok).toBe(false);
    });

    it('refuses a MEMBER share and an email-INVITE share on a drone: links only (owner 2026-10-28)', () => {
        for (const origin of ['member', 'invite']) {
            const r = principalOf(grant({ src: 'share', share_origin: origin, scope: ['workspace:design'], aud_role: 'drone' }));
            expect(r.ok).toBe(false);
            expect((r as { reason: string }).reason).toMatch(/share link/);
        }
    });

    it('refuses a share grant that does not say where it came from (an older Tynn, or a share of unknown origin)', () => {
        const r = principalOf(grant({ src: 'share', scope: ['workspace:design'], aud_role: 'drone' }));
        expect(r.ok).toBe(false);
        expect((r as { reason: string }).reason).toMatch(/share link/);
    });

    it('a share_origin "link" on anything but a share grants nothing extra', () => {
        for (const src of ['grant', 'invite', 'owner']) {
            expect(principalOf(grant({ src, share_origin: 'link', scope: ['workspace:design'], aud_role: 'drone' })).ok).toBe(false);
        }
    });

    it('still refuses every OTHER guest — a direct grant, an invite — whatever its scope', () => {
        for (const src of ['grant', 'invite', 'guest', '']) {
            for (const scope of [['host:all'], ['workspace:design']]) {
                expect(principalOf(grant({ src, src_ws: 'ws_other', scope, aud_role: 'drone' })).ok).toBe(false);
            }
        }
        // And a grant with no source at all.
        expect(principalOf(grant({ scope: ['workspace:design'], aud_role: 'drone' })).ok).toBe(false);
    });

    it('a share-link guest can never be taken for the owner, even carrying owner-looking claims', () => {
        const r = principalOf(grant({ src: 'share', share_origin: 'link', src_ws: 'ws_pilot', scope: ['host:all'], name: 'owner', aud_role: 'drone' }));
        expect(r).toMatchObject({ ok: true, principal: { isOwner: false } });
    });

    it('a grant that does not say the host is a pilot is judged as a drone\'s', () => {
        expect(principalOf(grant({ src: 'invite', scope: ['workspace:design'] })).ok).toBe(false);
        expect(principalOf(grant({ src: 'share', share_origin: 'link', scope: ['workspace:design'] }))).toMatchObject({ ok: true, principal: { isOwner: false, workspaceId: 'design' } });
        expect(principalOf(grant({ src: 'share', share_origin: 'member', scope: ['workspace:design'] })).ok).toBe(false);
        expect(principalOf(grant({ src: 'owner' })).ok).toBe(false);
        expect(principalOf(grant({ src: 'owner', src_ws: 'ws_pilot' })).ok).toBe(true);
    });

    it('a PILOT host keeps today\'s rules: the owner from anywhere, a guest scoped by its grant (CONTROL)', () => {
        expect(principalOf(grant({ src: 'owner', aud_role: 'pilot' }))).toMatchObject({ ok: true, principal: { isOwner: true } });
        expect(principalOf(grant({ src: 'invite', scope: ['workspace:design'], aud_role: 'pilot' }))).toMatchObject({ ok: true, principal: { isOwner: false, workspaceId: 'design' } });
        // A pilot admits every share, whatever its origin — and an old-format share with none (unchanged behaviour).
        for (const origin of ['link', 'member', 'invite', undefined]) {
            expect(principalOf(grant({ src: 'share', share_origin: origin, scope: ['workspace:design'], aud_role: 'pilot' }))).toMatchObject({ ok: true, principal: { isOwner: false, workspaceId: 'design' } });
        }
    });
});
