import { createPublicKey, verify } from 'node:crypto';
import type { PreAuth } from '../core/remote-protocol.js';

/**
 * A TYNN CONNECT GRANT, CHECKED BY THE HOST (Tynn #838) — Genie 1's `host-core/relay-host/grant.ts`, unchanged.
 *
 * Tynn mints a short-lived EdDSA JWS (`typ: wsgrant+jwt`) for a member it entitles to this workstation: who (`sub`,
 * `name`), how (`cap`: control | readonly), where (`scope`: `host:all` or `workspace:<id>`), why (`src`: owner, grant,
 * invite), until when (`exp`), bound to the member's key (`cnf.jkt`). The host verifies it against Tynn's published
 * keys, offline; whether it is STILL active (revoked, workstation locked) is Tynn's introspection, asked separately.
 */

export interface TynnJwk {
    kty: string;
    crv: string;
    kid: string;
    x: string;
    alg?: string;
    use?: string;
}

export type WorkspaceScope = 'host:all' | `workspace:${string}`;

export interface HostGrant {
    jti: string;
    sub: string;
    name: string | null;
    source: string | null;
    capability: 'control' | 'readonly';
    scopes: WorkspaceScope[];
    expiresAt: number;
    confirmationKeyThumbprint?: string;
    /** What Tynn says THIS workstation is (`aud_role`, genie#1278); anything but exactly "pilot" reads as drone. */
    audRole: 'pilot' | 'drone';
    /** The caller's own registered machine (`src_ws`), resolved by Tynn from its device binding; null when none. */
    sourceWorkstationId: string | null;
    /** Where a `src: share` grant's share came from (`share_origin`): a redeemed share LINK, an email invite, or an
     *  owner-made member share. Null when the grant does not say (an older Tynn, or a share of unknown origin). */
    shareOrigin: 'link' | 'invite' | 'member' | null;
}

export type GrantCheck = { ok: true; grant: HostGrant } | { ok: false; reason: string };

const MEMBER_GRANT_TYPE = 'wsgrant+jwt';

function segment(seg: string): Record<string, unknown> | null {
    try {
        const v = JSON.parse(Buffer.from(seg, 'base64url').toString('utf8')) as unknown;
        return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
    } catch {
        return null;
    }
}

const isScope = (v: unknown): v is WorkspaceScope => v === 'host:all' || (typeof v === 'string' && v.startsWith('workspace:') && v.length > 'workspace:'.length);
const text = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

export function verifyMemberGrant(token: string, opts: { keys: readonly TynnJwk[]; workstationId: string; now?: number; leewaySec?: number }): GrantCheck {
    const parts = token.split('.');
    if (parts.length !== 3) return { ok: false, reason: 'not a compact JWS' };
    const [h, p, s] = parts as [string, string, string];
    const header = segment(h);
    const claims = segment(p);
    if (!header || !claims) return { ok: false, reason: 'invalid JWS encoding' };
    if (header.alg !== 'EdDSA') return { ok: false, reason: 'unsupported algorithm' };
    if (header.typ !== undefined && header.typ !== MEMBER_GRANT_TYPE) return { ok: false, reason: 'not a member grant' };

    const jwk = opts.keys.find((k) => k.kid === header.kid);
    if (!jwk) return { ok: false, reason: 'unknown signing key' };
    let signed = false;
    try {
        const key = createPublicKey({ key: { kty: jwk.kty, crv: jwk.crv, x: jwk.x }, format: 'jwk' });
        signed = verify(null, Buffer.from(`${h}.${p}`, 'ascii'), key, Buffer.from(s, 'base64url'));
    } catch {
        signed = false;
    }
    if (!signed) return { ok: false, reason: 'signature verification failed' };

    const nowSec = Math.floor((opts.now ?? Date.now()) / 1000);
    const leeway = opts.leewaySec ?? 60;
    if (typeof claims.exp !== 'number' || nowSec > claims.exp + leeway) return { ok: false, reason: 'grant expired' };
    if (typeof claims.nbf === 'number' && nowSec + leeway < claims.nbf) return { ok: false, reason: 'grant not yet valid' };
    if (claims.aud !== opts.workstationId) return { ok: false, reason: 'grant audience mismatch' };

    const jti = text(claims.jti);
    const sub = text(claims.sub);
    const capability = claims.cap === 'control' || claims.cap === 'readonly' ? claims.cap : null;
    const scopes = Array.isArray(claims.scope) && claims.scope.length > 0 && claims.scope.every(isScope) ? (claims.scope as WorkspaceScope[]) : null;
    if (!jti || !sub || !capability || !scopes) return { ok: false, reason: 'invalid grant claims' };

    const cnf = claims.cnf !== null && typeof claims.cnf === 'object' ? text((claims.cnf as Record<string, unknown>).jkt) : null;
    return {
        ok: true,
        grant: {
            jti, sub, name: text(claims.name), source: text(claims.src), capability, scopes, expiresAt: claims.exp * 1000,
            audRole: claims.aud_role === 'pilot' ? 'pilot' : 'drone',
            sourceWorkstationId: text(claims.src_ws),
            shareOrigin: claims.share_origin === 'link' || claims.share_origin === 'invite' || claims.share_origin === 'member' ? claims.share_origin : null,
            ...(cnf ? { confirmationKeyThumbprint: cnf } : {}),
        },
    };
}

/**
 * Who the grant's holder is on THIS Genie. The owner's own grant is the owner; anyone else is a guest — of the whole
 * host (`host:all`), or of the one workspace named. Genie 2 scopes a guest to a single workspace, so a grant naming
 * several is refused in words rather than widened.
 */
export function principalOf(grant: HostGrant): { ok: true; principal: PreAuth } | { ok: false; reason: string } {
    const label = grant.name ?? grant.sub;
    const readonly = grant.capability === 'readonly';
    // A DRONE (genie#1278 W5; the owner: drones "auto-accept connections from known and paired devices"; 2026-10-28:
    // "allow share links", then "links only") admits its owner connecting from one of the owner's own registered
    // machines, and a guest whose access came from a redeemed share LINK (`src = share` with `share_origin = link`),
    // scoped by that grant below exactly as on a pilot and never the owner. A member share, an email-invite share, a
    // share grant that does not say its origin (an older Tynn, or a share written before origins were kept), every
    // other guest, and an owner from an unbound device are refused. All of it from the Tynn-signed grant.
    const ownersOwnMachine = grant.source === 'owner' && grant.sourceWorkstationId !== null;
    const shareLink = grant.source === 'share' && grant.shareOrigin === 'link';
    if (grant.audRole !== 'pilot' && !ownersOwnMachine && !shareLink) {
        if (grant.source === 'share') {
            return { ok: false, reason: `this workstation is a drone: it admits a guest only through a share link, and this access came from ${grant.shareOrigin === 'member' ? 'a member share' : grant.shareOrigin === 'invite' ? 'an email invite' : 'a share Tynn did not identify as a link'}` };
        }
        return { ok: false, reason: 'this workstation is a drone: it accepts only its owner, from the owner’s own paired machines, and share links' };
    }
    if (grant.source === 'owner') return { ok: true, principal: { label, isOwner: true, workspaceId: null, readonly } };
    if (grant.scopes.includes('host:all')) return { ok: true, principal: { label, isOwner: false, workspaceId: null, readonly } };
    const workspaces = grant.scopes.map((s) => s.slice('workspace:'.length));
    if (workspaces.length !== 1) return { ok: false, reason: `this Genie shares one workspace per link; this grant names ${workspaces.length}` };
    return { ok: true, principal: { label, isOwner: false, workspaceId: workspaces[0]!, readonly } };
}
