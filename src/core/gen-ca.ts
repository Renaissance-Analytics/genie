import type { DeckItem } from './deck.js';

/**
 * GENIE'S OWN CERTIFICATE AUTHORITY FOR `.gen` — the planning half (pure; `main/gen-ca.ts` does the files, the crypto
 * and the OS). Genie 1's design, carried over (repos/genie main/dev-server/host-ca.ts):
 *
 * - ONE persisted CA, "Genie Local Development CA" (O=Genie), valid ten years and renewed 30 days before it expires;
 *   its key never leaves Genie's data dir.
 * - ONE leaf covering every browser-exposed `.gen` name (SAN = every front-door route host), valid 397 days — under the
 *   398-day cap browsers enforce even for a private root — re-issued when the host set changes or within 30 days of
 *   expiry, and not otherwise.
 * - The CA's trust is installed into the OS store ONCE, under one elevation, on the person's word.
 *
 * Which CA: Genie 2's own if it has one; else Genie 1's (`host-gen/gen-ca.crt` + `.key`), ADOPTED by copying — Genie 1
 * already put that root in the owner's trust store, so adopting it is what makes an upgrade come up trusted with no
 * prompt at all; else a new one. Trust is never remembered by a marker: it is READ from the OS store by the CA's
 * thumbprint, so a root someone removed reads as untrusted and one Genie 1 installed reads as trusted.
 */

export const GEN_CA_SUBJECT = { commonName: 'Genie Local Development CA', organization: 'Genie' } as const;

const DAY_MS = 24 * 60 * 60 * 1000;
/** ~10 years: a trusted root should not make the person re-trust often. */
export const CA_VALIDITY_MS = 3650 * DAY_MS;
/** 397 days: under the 398-day cap browsers enforce on server leaves, private roots included. */
export const LEAF_VALIDITY_MS = 397 * DAY_MS;
/** Both are renewed this long before they lapse, so a site never goes dark on the day itself. */
export const RENEW_MARGIN_MS = 30 * DAY_MS;
/** Issued an hour in the past, so a clock a little behind does not read a fresh certificate as not yet valid. */
export const BACKDATE_MS = 60 * 60 * 1000;

/** What Genie read from a CA's files. `null` (in the inputs below) = no files there. */
export interface CaFacts {
    readonly isCa: boolean;
    /** Epoch ms. */
    readonly notAfter: number;
    /** The key file holds the private key of THIS certificate. */
    readonly keyMatches: boolean;
}

export type CaChoice = { readonly use: 'own' } | { readonly use: 'v1'; readonly index: number } | { readonly use: 'create'; readonly why: string };

const usable = (f: CaFacts | null, now: number): f is CaFacts => f !== null && f.isCa && f.keyMatches && f.notAfter - now > RENEW_MARGIN_MS;

const unusable = (label: string, f: CaFacts | null, now: number): string | null => {
    if (f === null) return null;
    if (!f.isCa) return `${label} is not a CA certificate`;
    if (!f.keyMatches) return `${label}'s key does not match its certificate`;
    return `${label} expires ${new Date(f.notAfter).toISOString().slice(0, 10)}, within the renewal window`;
};

/** Own > Genie 1's (first usable folder) > new. A CA that is not a CA, has no matching key, or is near expiry is passed over. */
export function chooseCa(input: { own: CaFacts | null; v1: readonly (CaFacts | null)[]; now: number }): CaChoice {
    if (usable(input.own, input.now)) return { use: 'own' };
    const index = input.v1.findIndex((f) => usable(f, input.now));
    if (index >= 0) return { use: 'v1', index };
    const reasons = [unusable('Genie 2’s CA', input.own, input.now), ...input.v1.map((f) => unusable('Genie 1’s CA', f, input.now))].filter((r): r is string => r !== null);
    return { use: 'create', why: reasons.length > 0 ? reasons.join('; ') : 'no CA on this machine yet' };
}

/** What Genie read from the leaf on disk. */
export interface LeafFacts {
    /** Its DNS SANs, normalised. */
    readonly hosts: readonly string[];
    readonly notAfter: number;
    /** Signed by the CA in use and its key file matches it. */
    readonly fromCa: boolean;
}

export type LeafReason = 'missing' | 'other-ca' | 'hosts-changed' | 'expiring';

const GEN_HOST = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+gen$/;

/** The leaf's names: lowercased, deduped, sorted. A name that is not a `.gen` hostname is refused, never written into a SAN. */
export function leafHosts(hosts: readonly string[]): string[] {
    const names = [...new Set(hosts.map((h) => h.trim().toLowerCase()))].sort();
    for (const n of names) if (!GEN_HOST.test(n)) throw new Error(`${JSON.stringify(n)} is not a .gen hostname; Genie’s certificate names .gen sites only`);
    return names;
}

/** Why the leaf must be issued again, or `null` when the one on disk still serves. */
export function leafNeed(input: { leaf: LeafFacts | null; hosts: readonly string[]; now: number }): LeafReason | null {
    const { leaf, hosts, now } = input;
    if (leaf === null) return 'missing';
    if (!leaf.fromCa) return 'other-ca';
    const want = leafHosts(hosts);
    if (want.length !== leaf.hosts.length || want.some((h, i) => h !== leaf.hosts[i])) return 'hosts-changed';
    if (leaf.notAfter - now <= RENEW_MARGIN_MS) return 'expiring';
    return null;
}

/** A SHA-1 thumbprint as Windows prints it: forty upper-case hex digits, no separators. */
export function normaliseThumbprint(fingerprint: string): string {
    const t = fingerprint.replace(/[:\s]/g, '').toUpperCase();
    if (!/^[0-9A-F]{40}$/.test(t)) throw new Error(`${JSON.stringify(fingerprint)} is not a SHA-1 thumbprint`);
    return t;
}

/** One command, run through the OS's elevation prompt (main/elevate.ts `Step`). */
export interface TrustStep {
    readonly command: string;
    readonly args: readonly string[];
}

/**
 * INSTALLING THE CA'S TRUST, per OS — Genie 1's commands. Windows: `certutil -addstore -f Root` (elevated, so the
 * machine's Trusted Root store; -f overwrites a copy already there). macOS: the System keychain as a trusted root.
 * Linux: Debian/Ubuntu's `update-ca-certificates` when it exists (p11-kit's store is read-only there), else p11-kit's
 * `trust anchor --store`. The path travels as `$1`, never spliced into the script.
 */
export function trustInstallStep(platform: NodeJS.Platform, caCertPath: string): TrustStep {
    if (platform === 'win32') return { command: 'certutil', args: ['-addstore', '-f', 'Root', caCertPath] };
    if (platform === 'darwin') return { command: 'security', args: ['add-trusted-cert', '-d', '-r', 'trustRoot', '-k', '/Library/Keychains/System.keychain', caCertPath] };
    const script = 'if command -v update-ca-certificates >/dev/null 2>&1; then cp -f "$1" /usr/local/share/ca-certificates/genie-local-development-ca.crt && update-ca-certificates; else trust anchor --store "$1"; fi';
    return { command: '/bin/sh', args: ['-c', script, 'sh', caCertPath] };
}

/**
 * READING THE TRUST STORE FOR THIS CA, per OS, read-only and by thumbprint. Windows: both Root stores the browsers
 * read (the machine's, where an elevated certutil puts it, and the user's, where Genie 1 also had it), answering
 * `True`/`False`. macOS: the System keychain's SHA-1 list. Linux: the system bundles, whose certificates are hashed.
 */
export type TrustQuery =
    | { readonly kind: 'command'; readonly command: string; readonly args: readonly string[] }
    | { readonly kind: 'bundles'; readonly paths: readonly string[] };

export const LINUX_TRUST_BUNDLES: readonly string[] = [
    '/etc/ssl/certs/ca-certificates.crt',
    '/etc/pki/tls/certs/ca-bundle.crt',
    '/etc/ca-certificates/extracted/tls-ca-bundle.pem',
    '/etc/ssl/cert.pem',
];

export function trustQuery(platform: NodeJS.Platform, thumbprint: string): TrustQuery {
    const t = normaliseThumbprint(thumbprint);
    if (platform === 'win32') {
        return {
            kind: 'command',
            command: 'powershell',
            args: ['-NoProfile', '-NonInteractive', '-Command', `(Test-Path -LiteralPath 'Cert:\\LocalMachine\\Root\\${t}') -or (Test-Path -LiteralPath 'Cert:\\CurrentUser\\Root\\${t}')`],
        };
    }
    if (platform === 'darwin') return { kind: 'command', command: 'security', args: ['find-certificate', '-a', '-Z', '/Library/Keychains/System.keychain'] };
    return { kind: 'bundles', paths: LINUX_TRUST_BUNDLES };
}

/** The command's answer, read strictly: an answer that is neither yes nor no is an error, never a "no". */
export function trustAnswer(platform: NodeJS.Platform, stdout: string, thumbprint: string): boolean {
    const t = normaliseThumbprint(thumbprint);
    if (platform === 'win32') {
        const answer = stdout.trim();
        if (answer === 'True') return true;
        if (answer === 'False') return false;
        throw new Error(`the Windows certificate store answered ${JSON.stringify(answer.slice(0, 200))}, not True or False`);
    }
    const listed = [...stdout.matchAll(/SHA-1 hash:\s*([0-9A-Fa-f]{40})/g)].map((m) => m[1]!.toUpperCase());
    return listed.includes(t);
}

export const TRUST_DECK_ID = 'genie:trust-certificate';

/**
 * THE ONE TIME GENIE ASKS (the Deck): only when the CA is KNOWN to be untrusted (`null` = not read yet — no item),
 * at least one site exists, and the person has not said Not now to THIS CA. Hosting's Trust line stays as the second
 * door either way.
 */
export function trustDeckItem(input: { trusted: boolean | null; sites: number; host: string | null; deferredFor: string | null; thumbprint: string; at: number }): DeckItem | null {
    if (input.trusted !== false || input.sites === 0 || input.deferredFor === input.thumbprint) return null;
    return {
        id: TRUST_DECK_ID,
        source: 'genie',
        agentId: null,
        agentName: null,
        workspaceId: null,
        title: `Trust Genie’s certificate so https://${input.host ?? '<name>.gen'} works in your browser`,
        blocking: false,
        priority: 'normal',
        at: input.at,
        answer: { kind: 'inline', options: [{ id: 'trust', label: 'Trust', tone: 'ok' }, { id: 'not-now', label: 'Not now', tone: 'neutral' }] },
        forwardedFrom: null,
    };
}
