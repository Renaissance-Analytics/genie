import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import tls from 'node:tls';

/**
 * Local-site DISCOVERY for serve-local-sites (Phase B). The hosts file is the
 * Herd-agnostic source of truth: any local proxy (Herd, Valet, nginx, dnsmasq,
 * a hand-rolled vhost) that serves `something.test` first maps that name to
 * loopback in the hosts file. We parse it — never assume Herd — to learn the
 * candidate dev-site NAMES, then probe loopback to learn the scheme + port the
 * hosts file can't carry.
 *
 * Split, mirroring `tailnet.ts`:
 *   - PURE (unit-tested directly, no I/O): `parseHostsFile`, `deriveGenName`,
 *     `siteIdFor`, `mergeSites`, `sanitizeTunnelPatch`, `parseTunnelSites`.
 *   - THIN IMPURE (fs / net / tls): `hostsFilePath`, `readHostsFile`,
 *     `probeSite`, `discoverSites`. These never touch the DB — the caller
 *     injects the workspace's stored tunnel settings, so this module stays a
 *     standalone, side-effect-free-on-import feature unit.
 */

// --- types -----------------------------------------------------------------

/** A discovered site's classification. Regular dev vhosts are `'site'`; Docker /
 *  Minikube / WSL helper names are `'infra'` and default OFF in the allowlist. */
export type SiteKind = 'site' | 'infra';

/** The scheme a site is served under on loopback (measured by {@link probeSite}). */
export type SiteScheme = 'http' | 'https';

/** The measured `{scheme, port}` a site answers on at loopback. */
export interface SiteProbe {
    scheme: SiteScheme;
    port: number;
}

/** One candidate site from the hosts file (name + kind + opaque id) — no
 *  scheme/port yet (the hosts file carries neither; {@link probeSite} adds them). */
export interface SiteDescriptor {
    /** Loopback-mapped hostname, lowercased (e.g. `tynn.test`). */
    hostname: string;
    /** `'site'` (a real dev vhost) or `'infra'` (docker/minikube/WSL helper). */
    kind: SiteKind;
    /** Opaque, stable per-host id — the ALLOWLIST KEY. A later proxy is keyed by
     *  this id (never a remote-supplied hostname/target), so it can only ever be
     *  told to reach an already-discovered, already-enabled site. */
    siteId: string;
}

/** Per-site tunnel config stored per-workspace (the §5 allowlist entry). Sparse:
 *  an absent field falls back to a derived/probed default at merge time. */
export interface TunnelSiteConfig {
    /** Whether this site is tunnelled. Absent/false ⇒ NOT served (opt-in). */
    enabled?: boolean;
    /** The assigned `*.gen` tunnel name; absent ⇒ derived from the hostname. */
    genName?: string;
    /** Manual scheme override; absent ⇒ the probed (or convention-default) scheme. */
    scheme?: SiteScheme;
    /** Manual port override; absent ⇒ the probed (or convention-default) port. */
    port?: number;
    /** Explicit loopback services owned by this site (Vite, Reverb, Next dev,
     * etc.). Each receives its own browser-facing hostname and opaque route id. */
    companions?: CompanionEndpointConfig[];
}

export interface CompanionEndpointConfig {
    /** Stable, human-readable key within the owning site. */
    id: string;
    /** Strict opt-in. */
    enabled?: boolean;
    /** User-selected browser-facing hostname (including nested subdomains),
     * resolved only inside this Testing Browser session. */
    hostname: string;
    scheme: SiteScheme;
    port: number;
}

/** A workspace's per-site tunnel settings, keyed by the opaque {@link siteIdFor}. */
export type TunnelSites = Record<string, TunnelSiteConfig>;

/** A discovered site merged with its stored config — the `/api/sites` row shape. */
export interface SiteView {
    hostname: string;
    scheme: SiteScheme;
    port: number;
    kind: SiteKind;
    /** Resolved from the stored config's `enabled` (default false). */
    enabled: boolean;
    /** Resolved `*.gen` name (stored override, else derived). */
    genName: string;
    /** The opaque allowlist key (also the settings map key). */
    siteId: string;
    companions?: CompanionEndpointView[];
}

export interface CompanionEndpointView extends CompanionEndpointConfig {
    siteId: string;
}

/** The convention default when a site hasn't been probed and has no override —
 *  Herd/Valet serve `*.test` on 443/https (with 80/http redirecting up). */
export const DEFAULT_PROBE: SiteProbe = { scheme: 'https', port: 443 };

// --- per-OS path -----------------------------------------------------------

/**
 * The OS hosts-file path. On Windows we resolve `%SystemRoot%` (never hardcode
 * `C:\Windows` — some installs relocate it); macOS/Linux use `/etc/hosts`.
 */
export function hostsFilePath(): string {
    if (process.platform === 'win32') {
        const root = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
        return path.join(root, 'System32', 'drivers', 'etc', 'hosts');
    }
    return '/etc/hosts';
}

// --- pure parse ------------------------------------------------------------

/** Names that are loopback plumbing, not dev sites — dropped outright. */
const NOISE_NAMES = new Set([
    'localhost',
    'localhost.localdomain',
    'broadcasthost',
    'ip6-localhost',
    'ip6-loopback',
    'ip6-allnodes',
    'ip6-allrouters',
]);

/** Explicit infra helper names surfaced but defaulted OFF (see also the generic
 *  `.internal` suffix rule in {@link classifyName}). */
const INFRA_NAMES = new Set([
    'host.docker.internal',
    'gateway.docker.internal',
    'kubernetes.docker.internal',
    'host.minikube.internal',
    'control-plane.minikube.internal',
]);

/** True when `ip` maps to loopback: the WHOLE 127.0.0.0/8 (some setups split
 *  sites across 127.0.0.2/.3/…) or IPv6 `::1`. `0.0.0.0` (all-interfaces / a
 *  common ad-block sink) is NOT loopback and is excluded. */
export function isLoopbackIp(ip: string): boolean {
    const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
    if (v4) {
        const octets = v4.slice(1, 5).map(Number);
        if (octets.some((n) => n > 255)) return false;
        return octets[0] === 127; // entire 127.0.0.0/8
    }
    const low = ip.toLowerCase();
    return low === '::1' || low === '0:0:0:0:0:0:0:1';
}

/** Classify a candidate hostname: `null` = noise (drop), else its {@link SiteKind}. */
function classifyName(name: string): SiteKind | null {
    const h = name.toLowerCase();
    if (!h) return null;
    if (NOISE_NAMES.has(h)) return null;
    // Bare `*.localhost` (and `localhost` itself) resolve to loopback by
    // convention already and aren't real dev vhosts — drop them.
    if (h === 'localhost' || h.endsWith('.localhost')) return null;
    // Docker / Minikube / WSL helper endpoints: surfaced but defaulted off. The
    // explicit set plus the generic `.internal` suffix covers the common helpers.
    if (INFRA_NAMES.has(h) || h.endsWith('.internal')) return 'infra';
    return 'site';
}

/** Cap on distinct sites returned, so a pathological hosts file can't blow up. */
const MAX_SITES = 500;

/**
 * PURE. Parse hosts-file text into candidate site descriptors, applying the §1
 * rules: strip `#` comments; tokenize on whitespace (IP + one-or-more names);
 * KEEP ONLY loopback-mapped lines (127.0.0.0/8 or `::1`); drop noise
 * (`localhost`, `broadcasthost`, `*.localhost`, `0.0.0.0`, blanks); FLAG infra
 * names (`*.docker.internal`, minikube/WSL `.internal`) as `kind:'infra'`;
 * dedupe case-insensitively and MERGE the IPv4 + IPv6 rows for one name.
 */
export function parseHostsFile(text: string): SiteDescriptor[] {
    const seen = new Map<string, SiteDescriptor>();
    for (const rawLine of text.split(/\r?\n/)) {
        // 1. Strip everything from the first `#`.
        const line = rawLine.split('#', 1)[0];
        // 2. Tokenize on whitespace: first token = IP, rest = hostnames.
        const tokens = line.trim().split(/\s+/).filter(Boolean);
        if (tokens.length < 2) continue;
        const [ip, ...names] = tokens;
        // 3. Keep only loopback-mapped lines.
        if (!isLoopbackIp(ip)) continue;
        for (const name of names) {
            const kind = classifyName(name);
            if (!kind) continue; // 4. drop noise
            const hostname = name.toLowerCase();
            // 6. dedupe case-insensitively + merge IPv4/IPv6 for the same name.
            const existing = seen.get(hostname);
            if (existing) {
                // A name seen as both site + infra stays infra (fail safe: OFF).
                if (kind === 'infra') existing.kind = 'infra';
                continue;
            }
            if (seen.size >= MAX_SITES) break;
            seen.set(hostname, { hostname, kind, siteId: siteIdFor(hostname) });
        }
    }
    return [...seen.values()];
}

// --- pure helpers ----------------------------------------------------------

/**
 * PURE. Derive the default `*.gen` tunnel name from a discovered hostname:
 * replace the final label (the TLD) with `gen` — `tynn.test` → `tynn.gen`,
 * `mail.tynn.test` → `mail.tynn.gen`. A name with no dot gets `.gen` appended.
 */
export function deriveGenName(hostname: string): string {
    const h = hostname.toLowerCase().replace(/\.$/, '');
    const dot = h.lastIndexOf('.');
    return dot > 0 ? `${h.slice(0, dot)}.gen` : `${h}.gen`;
}

/**
 * PURE. An opaque, STABLE id for a hostname — the allowlist key. A truncated
 * sha256 of the lowercased name: deterministic (same host → same id across
 * discoveries), non-guessable-as-a-target, and safe as a map key / URL segment.
 */
export function siteIdFor(hostname: string): string {
    return crypto.createHash('sha256').update(hostname.toLowerCase()).digest('hex').slice(0, 16);
}

/** Opaque route identity for a companion, scoped to its owning site. */
export function companionSiteIdFor(ownerSiteId: string, endpointId: string): string {
    return crypto
        .createHash('sha256')
        .update(`${ownerSiteId}\0${endpointId}`)
        .digest('hex')
        .slice(0, 16);
}

/**
 * PURE. Normalize an untrusted tunnel-config patch: only well-typed fields
 * survive, port is clamped to 1..65535, scheme to `http`/`https`, genName is
 * trimmed + length-capped. Never trust a remote/renderer to send a clean shape.
 */
export function sanitizeTunnelPatch(patch: TunnelSiteConfig | null | undefined): TunnelSiteConfig {
    const out: TunnelSiteConfig = {};
    if (!patch || typeof patch !== 'object') return out;
    if (typeof patch.enabled === 'boolean') out.enabled = patch.enabled;
    if (patch.scheme === 'http' || patch.scheme === 'https') out.scheme = patch.scheme;
    if (typeof patch.port === 'number' && Number.isFinite(patch.port)) {
        const p = Math.trunc(patch.port);
        if (p >= 1 && p <= 65535) out.port = p;
    }
    if (typeof patch.genName === 'string') {
        const g = patch.genName.trim().slice(0, 255);
        if (g) out.genName = g;
    }
    if (Array.isArray(patch.companions)) {
        const companions: CompanionEndpointConfig[] = [];
        const seen = new Set<string>();
        for (const raw of patch.companions.slice(0, 16)) {
            if (!raw || typeof raw !== 'object') continue;
            const id = typeof raw.id === 'string' ? raw.id.trim().toLowerCase() : '';
            const hostname =
                typeof raw.hostname === 'string'
                    ? raw.hostname.trim().toLowerCase().replace(/\.$/, '')
                    : '';
            const port =
                typeof raw.port === 'number' && Number.isFinite(raw.port)
                    ? Math.trunc(raw.port)
                    : 0;
            if (
                !/^[a-z0-9][a-z0-9_-]{0,31}$/.test(id) ||
                seen.has(id) ||
                raw.enabled !== true ||
                (raw.scheme !== 'http' && raw.scheme !== 'https') ||
                port < 1 ||
                port > 65535 ||
                !isValidMappedHostname(hostname)
            ) {
                continue;
            }
            seen.add(id);
            companions.push({ id, enabled: true, hostname, scheme: raw.scheme, port });
        }
        if (companions.length) out.companions = companions;
    }
    return out;
}

/** Exact browser-facing DNS name validation. The destination remains loopback;
 * this name is only a session-local routing key and may use any valid domain. */
export function isValidMappedHostname(hostname: string): boolean {
    if (!hostname || hostname.length > 253 || hostname.includes('..')) return false;
    if (net.isIP(hostname)) return false;
    return hostname.split('.').every(
        (label) =>
            label.length >= 1 &&
            label.length <= 63 &&
            /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label),
    );
}

/**
 * PURE. Parse a stored `tunnel_sites` JSON blob into a sanitized map. Robust to
 * NULL, corrupt JSON, and junk values — an unparseable blob reads as `{}` (the
 * safe default: nothing enabled).
 */
export function parseTunnelSites(raw: string | null | undefined): TunnelSites {
    if (!raw) return {};
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return {};
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: TunnelSites = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        out[k] = sanitizeTunnelPatch(v as TunnelSiteConfig);
    }
    return out;
}

/**
 * PURE. Merge discovered descriptors with a workspace's stored tunnel settings
 * and any probe results into `/api/sites` rows. Resolution order per field:
 *   scheme/port → stored override, else probe, else the convention default;
 *   genName     → stored override (trimmed), else derived from the hostname;
 *   enabled     → strictly the stored `enabled === true` (default OFF; infra too).
 */
export function mergeSites(
    discovered: SiteDescriptor[],
    settings: TunnelSites,
    probes: Record<string, SiteProbe> = {},
): SiteView[] {
    return discovered.map((d) => {
        const cfg = settings[d.siteId] ?? {};
        const probe = probes[d.hostname];
        const scheme = cfg.scheme ?? probe?.scheme ?? DEFAULT_PROBE.scheme;
        const port = cfg.port ?? probe?.port ?? DEFAULT_PROBE.port;
        const genName = (cfg.genName ?? '').trim() || deriveGenName(d.hostname);
        const companions = (cfg.companions ?? []).map((endpoint) => ({
            ...endpoint,
            siteId: companionSiteIdFor(d.siteId, endpoint.id),
        }));
        return {
            hostname: d.hostname,
            scheme,
            port,
            kind: d.kind,
            enabled: cfg.enabled === true,
            genName,
            siteId: d.siteId,
            ...(companions.length ? { companions } : {}),
        };
    });
}

// --- thin impure (fs / net / tls) ------------------------------------------

/** Read the OS hosts file (best-effort — an unreadable file yields ''). */
export function readHostsFile(): string {
    try {
        return fs.readFileSync(hostsFilePath(), 'utf8');
    } catch {
        return '';
    }
}

/** Per-connection probe budget. Loopback answers fast; a dead port fails faster. */
const PROBE_TIMEOUT_MS = 800;

/** A TLS client handshake to `127.0.0.1:port` with SNI = hostname. Loopback has
 *  no MITM surface, so an untrusted (Herd) local cert is fine to accept. */
function tlsListens(hostname: string, port: number): Promise<boolean> {
    return new Promise((resolve) => {
        let done = false;
        const finish = (ok: boolean) => {
            if (done) return;
            done = true;
            try {
                socket.destroy();
            } catch {
                /* already gone */
            }
            resolve(ok);
        };
        const socket = tls.connect(
            {
                host: '127.0.0.1',
                port,
                servername: hostname,
                // Loopback (127.0.0.1) probe: no MITM surface, and a dev proxy's
                // self-signed .test cert can't be validated Herd-agnostically.
                // (Cloud dev-envs use real LetsEncrypt wildcard certs, §7.)
                rejectUnauthorized: false, // codeql[js/disabling-certificate-validation]
                timeout: PROBE_TIMEOUT_MS,
            },
            () => finish(true),
        );
        socket.on('secureConnect', () => finish(true));
        socket.on('timeout', () => finish(false));
        socket.on('error', () => finish(false));
    });
}

/** A plain TCP connect to `127.0.0.1:port` — a liveness probe for a plaintext
 *  HTTP vhost (the scheme is inferred from WHICH port answered). */
function tcpListens(port: number): Promise<boolean> {
    return new Promise((resolve) => {
        let done = false;
        const finish = (ok: boolean) => {
            if (done) return;
            done = true;
            try {
                socket.destroy();
            } catch {
                /* already gone */
            }
            resolve(ok);
        };
        const socket = net.connect({ host: '127.0.0.1', port, timeout: PROBE_TIMEOUT_MS });
        socket.on('connect', () => finish(true));
        socket.on('timeout', () => finish(false));
        socket.on('error', () => finish(false));
    });
}

/**
 * THIN IMPURE. Measure a site's scheme + port on loopback (never guess): TLS on
 * 443 (SNI = hostname) ⇒ https/443; else TCP on 80 ⇒ http/80; else a small
 * sweep — 8443 (https), 8080, 8000 (http) — for non-standard proxies. Returns
 * `null` when nothing answers (the caller then falls back to the convention
 * default at merge time). Re-run on demand to re-probe.
 */
export async function probeSite(hostname: string): Promise<SiteProbe | null> {
    if (await tlsListens(hostname, 443)) return { scheme: 'https', port: 443 };
    if (await tcpListens(80)) return { scheme: 'http', port: 80 };
    if (await tlsListens(hostname, 8443)) return { scheme: 'https', port: 8443 };
    if (await tcpListens(8080)) return { scheme: 'http', port: 8080 };
    if (await tcpListens(8000)) return { scheme: 'http', port: 8000 };
    return null;
}

/** Resolved-probe cache, keyed by hostname. `null` caches a "nothing answered"
 *  result so we don't re-sweep every listing. Cleared on an explicit refresh. */
const probeCache = new Map<string, SiteProbe | null>();

/** Drop every cached probe so the next {@link discoverSites} re-measures. */
export function clearProbeCache(): void {
    probeCache.clear();
}

/**
 * THIN IMPURE. Discover the host's loopback dev sites merged with the CALLER-
 * SUPPLIED tunnel settings (this module never touches the DB). Reads the hosts
 * file, probes each site's scheme/port (cached; `refresh` re-measures), and
 * returns the merged `/api/sites` rows.
 */
export async function discoverSites(
    settings: TunnelSites,
    opts?: { refresh?: boolean },
): Promise<SiteView[]> {
    const discovered = parseHostsFile(readHostsFile());
    if (opts?.refresh) clearProbeCache();
    const probes: Record<string, SiteProbe> = {};
    await Promise.all(
        discovered.map(async (d) => {
            let p = probeCache.get(d.hostname);
            if (p === undefined) {
                p = await probeSite(d.hostname).catch(() => null);
                probeCache.set(d.hostname, p);
            }
            if (p) probes[d.hostname] = p;
        }),
    );
    return mergeSites(discovered, settings, probes);
}
