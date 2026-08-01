import type { HostedSite } from './types';

/**
 * PURE Caddyfile generation for the FrankenPHP adapter.
 *
 * FrankenPHP *is* Caddy with PHP embedded, so its whole configuration surface is
 * a Caddyfile. Everything the adapter needs to express — which vhost, which
 * document root, PHP vs plain files, local TLS, worker mode — is a directive
 * here, which is why this is the one part of the adapter worth testing hard: a
 * wrong Caddyfile is a site that silently serves the wrong thing, or a server
 * that binds an address we did not intend.
 *
 * No I/O. `frankenphp.ts` writes the string this returns through an injected
 * {@link ConfigWriter} and passes the path with `--config`.
 */

// --- primitives ------------------------------------------------------------

/**
 * Caddyfile tokens are whitespace-separated; anything containing whitespace must
 * be quoted, and inside quotes `\` and `"` must be escaped.
 *
 * This matters far more on Windows than it looks: a Windows path arrives as
 * `C:\Users\me\repo\public`, and Caddy reads `\U` as an escape. We normalise
 * separators to `/` (which Caddy accepts on every OS) BEFORE quoting, so the
 * same generator is correct on all three platforms.
 */
export function caddyPath(p: string): string {
    return quote(p.replace(/\\/g, '/'));
}

/** Quote any Caddyfile token that needs it, escaping the two special chars. */
export function quote(value: string): string {
    const escaped = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    return /[\s"]/.test(value) ? `"${escaped}"` : escaped;
}

// --- options ---------------------------------------------------------------

export interface CaddyfileOptions {
    /** The loopback port this site is bound to (from `assignPort`). */
    port: number;
    /**
     * Where Caddy keeps its state — crucially the LOCAL CA's root key, which
     * must survive restarts or every restart re-issues a new root and the
     * browser's pinned trust breaks. Genie points this at its userData dir.
     */
    storageDir: string;
    /**
     * P1 NEVER writes the local CA root into the OS trust store.
     *
     * Caddy's default is to try, which on Windows raises a certificate-install
     * prompt (and on macOS an auth prompt) the first time a site starts — a
     * surprise system-wide change from what the user thinks is "preview my
     * site". Installing the root is P2's job, behind an explicit consent step.
     * Until then the Testing Browser trusts the leaf via its own session CA, so
     * nothing is lost.
     */
    skipInstallTrust?: boolean;
}

// --- generation ------------------------------------------------------------

/**
 * The global options block.
 *
 * `admin off` is a security decision, not tidiness: Caddy's admin API defaults
 * to listening on `localhost:2019` and can rewrite the running config, so any
 * local process could re-point a hosted site. We never use it, so it is off.
 */
export function globalBlock(opts: CaddyfileOptions): string {
    const lines = [
        '{',
        '\tadmin off',
        // Redirect http→https is pointless here: we only ever bind the one
        // https port, so leaving it on just makes Caddy claim a second port.
        '\tauto_https disable_redirects',
        `\tstorage file_system ${caddyPath(opts.storageDir)}`,
    ];
    if (opts.skipInstallTrust !== false) lines.push('\tskip_install_trust');
    lines.push('\tfrankenphp');
    lines.push('}');
    return lines.join('\n');
}

/** The `php_server` / `file_server` body for one site. */
function serveDirectives(site: HostedSite): string[] {
    if (site.kind === 'static') {
        // SPA fallback: a client-side router owns the path space, so anything
        // that is not a real file is the app shell — served from the SAME
        // origin, which is the entire point (no separate Vite/asset origin).
        return ['\ttry_files {path} {path}/ /index.html', '\tfile_server'];
    }

    const index = site.index ?? 'index.php';
    const body: string[] = [`\t\ttry_files {path} ${quote(index)}`];
    for (const [key, value] of Object.entries(site.env ?? {})) {
        body.push(`\t\tenv ${quote(key)} ${quote(value)}`);
    }
    if (site.worker) {
        body.push('\t\tworker {');
        body.push(`\t\t\tfile ${quote(site.worker.file)}`);
        if (site.worker.num !== undefined) body.push(`\t\t\tnum ${site.worker.num}`);
        for (const pattern of site.worker.watch ?? []) {
            body.push(`\t\t\twatch ${caddyPath(pattern)}`);
        }
        body.push('\t\t}');
    }
    return ['\tphp_server {', ...body, '\t}'];
}

/**
 * One site block.
 *
 * Two lines here are load-bearing:
 *
 * `bind 127.0.0.1` — without it Caddy binds every interface, so "preview my
 * site locally" would quietly publish the user's app to their LAN. Hosted sites
 * reach the outside world only through Genie's carrier, never by being exposed.
 *
 * `tls internal` — Caddy only picks its internal issuer automatically for
 * `localhost`-ish names. A `.test` vhost would otherwise be treated as public
 * and Caddy would attempt an ACME order against a name that cannot be
 * validated, failing the start. Local TLS must be stated, not assumed.
 */
export function siteBlock(site: HostedSite, opts: CaddyfileOptions): string {
    return [
        `https://${site.hostname.toLowerCase()}:${opts.port} {`,
        '\tbind 127.0.0.1',
        `\troot ${caddyPath(site.root)}`,
        '\tencode zstd br gzip',
        '\ttls internal',
        ...serveDirectives(site),
        '}',
    ].join('\n');
}

/** The complete Caddyfile FrankenPHP is started with for one site. */
export function renderCaddyfile(site: HostedSite, opts: CaddyfileOptions): string {
    return `${globalBlock(opts)}\n\n${siteBlock(site, opts)}\n`;
}
