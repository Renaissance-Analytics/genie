import { createPublicKey, verify as edVerify, type webcrypto } from 'node:crypto';

import type { AccessCapability, HostAccessPolicy, SitePermission, WorkspaceScope } from '../access-policy';

/**
 * A member's CONNECTION GRANT, as this machine checks it when it is a relay host
 * (genie#680) — the short-lived Ed25519 JWS Tynn mints at connect
 * (`MintWorkstationGrant`), verified offline against Tynn's published keys.
 *
 * genie-cloud has enforced this contract since it became a relay host
 * (`src/grant/jws.ts`); a desktop is now one too, so it is mirrored here rather
 * than imported across repos (the same arrangement `remote/relay-protocol.ts`
 * documents for the wire frames).
 *
 * Nothing a member sends widens it: the audience must be THIS workstation, the
 * signature Tynn's, the token a member grant (a relay ticket is signed by the same
 * key and is refused by type), and what it reaches is exactly its `scope`, `cap`
 * and `sites`.
 */

/** One of Tynn's published Ed25519 keys (`GET /api/v1/workstations/grants/public-keys`). */
export interface TynnJwk {
    kty: string;
    crv: string;
    kid: string;
    x: string;
    alg?: string;
    use?: string;
}

/** A verified member grant. */
export interface HostGrant {
    jti: string;
    /** The member's Tynn user id. */
    sub: string;
    /** Display name, for the host's roster. Null from a Tynn that predates the claim. */
    name: string | null;
    /** The entitlement it came from (`owner | share | grant | invite`), or null. */
    source: string | null;
    capability: AccessCapability;
    scopes: WorkspaceScope[];
    sitePermissions: Record<string, SitePermission>;
    /** Epoch ms. */
    expiresAt: number;
    /** `cnf.jkt` — the member key the session must prove possession of. */
    confirmationKeyThumbprint?: string;
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

function isScope(v: unknown): v is WorkspaceScope {
    return v === 'host:all' || (typeof v === 'string' && v.startsWith('workspace:') && v.length > 'workspace:'.length);
}

function readSites(v: unknown): Record<string, SitePermission> | null {
    if (v === undefined) return {};
    if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
    const out: Record<string, SitePermission> = {};
    for (const [site, permission] of Object.entries(v as Record<string, unknown>)) {
        if (permission !== 'browse' && permission !== 'interact') return null;
        out[site] = permission;
    }
    return out;
}

const text = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

export function verifyMemberGrant(
    token: string,
    opts: { keys: TynnJwk[]; workstationId: string; now?: number; leewaySec?: number },
): GrantCheck {
    const parts = token.split('.');
    if (parts.length !== 3) return { ok: false, reason: 'not a compact JWS' };
    const [h, p, s] = parts as [string, string, string];
    const header = segment(h);
    const claims = segment(p);
    if (!header || !claims) return { ok: false, reason: 'invalid JWS encoding' };
    if (header.alg !== 'EdDSA') return { ok: false, reason: 'unsupported algorithm' };
    // An absent typ is an older Tynn; any OTHER type (a relay ticket) is refused.
    if (header.typ !== undefined && header.typ !== MEMBER_GRANT_TYPE) return { ok: false, reason: 'not a member grant' };

    const jwk = opts.keys.find((k) => k.kid === header.kid);
    if (!jwk) return { ok: false, reason: 'unknown signing key' };
    let signed = false;
    try {
        const key = createPublicKey({ key: jwk as unknown as webcrypto.JsonWebKey, format: 'jwk' });
        signed = edVerify(null, Buffer.from(`${h}.${p}`, 'ascii'), key, Buffer.from(s, 'base64url'));
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
    const scopes = Array.isArray(claims.scope) && claims.scope.length > 0 && claims.scope.every(isScope) ? claims.scope : null;
    const sitePermissions = readSites(claims.sites);
    if (!jti || !sub || !capability || !scopes || !sitePermissions) return { ok: false, reason: 'invalid grant claims' };

    const cnf = claims.cnf !== null && typeof claims.cnf === 'object' ? text((claims.cnf as Record<string, unknown>).jkt) : null;
    return {
        ok: true,
        grant: {
            jti,
            sub,
            name: text(claims.name),
            source: text(claims.src),
            capability,
            scopes,
            sitePermissions,
            expiresAt: claims.exp * 1000,
            ...(cnf ? { confirmationKeyThumbprint: cnf } : {}),
        },
    };
}

/** The access policy a guest session minted from this grant is judged by (`mobile/guest-access.ts`). */
export function grantAccessPolicy(grant: HostGrant): HostAccessPolicy {
    return {
        principalId: grant.sub,
        principalType: 'tynn-user',
        transports: ['tynn'],
        capability: grant.capability,
        workspaceScopes: grant.scopes,
        sitePermissions: grant.sitePermissions,
    };
}
