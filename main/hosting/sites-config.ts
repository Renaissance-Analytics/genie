import path from 'node:path';
import { isValidMappedHostname, siteIdFor } from '../mobile/hosts';
import { isInside } from './paths';
import type { HostedSite, HostedSiteKind } from './types';

/**
 * The persisted per-workspace "sites enabled" model (Tynn #232, P2 item 5).
 *
 * A DISCOVERED site (`mobile/hosts.ts`) is something the machine already serves;
 * Genie only decides whether to tunnel it. A HOSTED site is the opposite: there
 * is nothing to discover, because Genie is the thing that will serve it. So it
 * needs its own stored intent — which vhost, PHP or static, and which directory
 * is the document root — keyed per workspace, exactly like `tunnel_sites`.
 *
 * This is the state the Workspace Site Manager (P3) will drive. P2 builds the
 * store and the resolve step only.
 *
 * SECURITY. {@link resolveHostedSite} is the single place a stored string turns
 * into a directory Genie serves to a browser, so containment is enforced there
 * as well as on the way in. A docroot is always RELATIVE to the workspace: an
 * absolute one would let a workspace's settings publish any directory on the
 * machine, and `..` would do the same more quietly. Both are refused twice —
 * once by {@link sanitizeHostedSitePatch} when written, once at resolve time so
 * a blob written by an older build (or by hand) still cannot escape.
 *
 * Everything in this file is PURE.
 */

// --- the model -------------------------------------------------------------

export interface HostedSiteConfig {
    /** Strict opt-in — nothing is hosted until this is true. */
    enabled: boolean;
    /** Browser-facing vhost, lowercased (e.g. `tynn.test`). Also the TLS SNI. */
    hostname: string;
    kind: HostedSiteKind;
    /** Document root RELATIVE to the workspace path. `''` = the workspace root. */
    docroot: string;
    /** `php`: the front controller. `static`: the SPA shell. File NAME, never a path. */
    index?: string;
}

/** A workspace's hosted sites, keyed by {@link hostedSiteIdFor}. */
export type HostedSites = Record<string, HostedSiteConfig>;

/**
 * The id a hosted site is stored and reported under.
 *
 * Deliberately the SAME derivation a discovered site uses (`siteIdFor`). That
 * single choice is what makes the Testing Browser wiring additive: a hosted site
 * keys `localTargetsBySiteId` at exactly the slot the hosts-file-discovered one
 * did, so "prefer the hosted target" is a map overwrite rather than a second
 * resolution path through the carrier.
 */
export function hostedSiteIdFor(hostname: string): string {
    return siteIdFor(hostname);
}

// --- sanitize --------------------------------------------------------------

/** A docroot may not be absolute, UNC, or climb out of its workspace. */
function sanitizeDocroot(value: unknown): string | undefined {
    if (typeof value !== 'string') return undefined;
    const forward = value.replace(/\\/g, '/').trim();
    if (forward.startsWith('//')) return undefined; // UNC
    if (path.isAbsolute(forward) || /^[a-zA-Z]:/.test(forward)) return undefined;
    // `path.normalize` collapses `.` and `..`; a leading `..` survives it, which
    // is exactly the case to refuse.
    const normalised = path.posix.normalize(forward).replace(/^\/+/, '').replace(/\/+$/, '');
    if (normalised === '.' || normalised === '') return '';
    if (normalised === '..' || normalised.startsWith('../')) return undefined;
    return normalised;
}

/** PURE. Normalize an untrusted patch: only well-typed, in-bounds fields survive. */
export function sanitizeHostedSitePatch(
    patch: Partial<HostedSiteConfig> | null | undefined,
): Partial<HostedSiteConfig> {
    const out: Partial<HostedSiteConfig> = {};
    if (!patch || typeof patch !== 'object') return out;

    if (typeof patch.enabled === 'boolean') out.enabled = patch.enabled;

    if (typeof patch.hostname === 'string') {
        const hostname = patch.hostname.trim().toLowerCase().replace(/\.$/, '');
        if (isValidMappedHostname(hostname)) out.hostname = hostname;
    }

    if (patch.kind === 'php' || patch.kind === 'static') out.kind = patch.kind;

    const docroot = sanitizeDocroot(patch.docroot);
    if (docroot !== undefined) out.docroot = docroot;

    if (typeof patch.index === 'string') {
        const index = patch.index.trim();
        // A FILE NAME, never a path: `index` is joined onto the docroot (by
        // Caddy for php, by the static adapter for the SPA shell), so a
        // separator there moves the front controller outside the served root.
        if (index && index === path.posix.basename(index.replace(/\\/g, '/')) && index !== '..') {
            out.index = index;
        }
    }

    return out;
}

/**
 * PURE. Parse a stored `hosted_sites` blob. Robust to NULL, corrupt JSON and
 * junk values — an unreadable blob reads as `{}` (the safe default: nothing
 * hosted).
 */
export function parseHostedSites(raw: string | null | undefined): HostedSites {
    if (!raw) return {};
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return {};
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: HostedSites = {};
    for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
        out[id] = sanitizeHostedSitePatch(value as HostedSiteConfig) as HostedSiteConfig;
    }
    return out;
}

// --- resolve ---------------------------------------------------------------

/**
 * PURE. Turn a stored config plus its workspace path into the runtime's
 * {@link HostedSite}, or `null` when the pair cannot safely be served.
 *
 * The containment check is repeated here on purpose — see the file header.
 */
export function resolveHostedSite(
    workspacePath: string,
    config: Partial<HostedSiteConfig>,
): HostedSite | null {
    const hostname = (config.hostname ?? '').trim().toLowerCase();
    if (!workspacePath || !hostname || !isValidMappedHostname(hostname)) return null;
    const kind: HostedSiteKind = config.kind === 'php' ? 'php' : 'static';

    const docroot = sanitizeDocroot(config.docroot ?? '');
    if (docroot === undefined) return null;

    const rootAbs = path.resolve(workspacePath);
    const resolved = path.resolve(rootAbs, docroot);
    if (!isInside(rootAbs, resolved)) return null;

    return {
        id: hostedSiteIdFor(hostname),
        hostname,
        root: resolved,
        kind,
        ...(config.index ? { index: config.index } : {}),
    };
}
