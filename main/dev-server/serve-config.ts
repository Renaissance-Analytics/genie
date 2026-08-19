/**
 * Genie owns the web-server config for the cases where a repo is NOT its own
 * server — so an agent declares a SERVE MODE and Genie renders the Caddyfile,
 * instead of hand-rolling `printf "server { … } " > /etc/nginx/... ; exec nginx`
 * (the owner's screenshot). Genie already bundles Caddy, so no new binary.
 *
 * Two generated modes, both plain-http listeners on a loopback port that the
 * `.gen` front door (which owns TLS) reverse-proxies to — identical, from the
 * router's view, to any other host-native site on a port:
 *   - `static` — serve a built directory over `file_server`, with an optional SPA
 *     fallback to `index.html` (client-side routing);
 *   - `php`    — serve `public/` and hand `.php` to a FastCGI worker (`php-cgi`),
 *     the nginx/Valet model, for the one language that is not its own web server.
 *
 * The THIRD case — a repo's own dev server, or a service the agent runs — is a
 * plain reverse-proxy and needs NO generated config; it stays on the Phase-1
 * host-native path. PURE builders here: deterministically testable, no fs/spawn.
 */

/** What a generated-config site serves. Reverse-proxy sites are NOT here — they
 *  need no config. */
export type SiteServe =
    | { kind: 'static'; root: string; spa: boolean }
    | { kind: 'php'; root: string; fcgiPort: number };

/** Quote a docroot for a Caddyfile: normalise Windows `\` to `/` (Caddy accepts
 *  it, and it dodges quote-escaping), then refuse anything that could break the
 *  quotes or inject a directive. */
function quoteRoot(p: string): string {
    if (typeof p !== 'string' || p.length === 0) {
        throw new Error('serve-config: missing root');
    }
    const norm = p.replace(/\\/g, '/');
    if (/["\n\r{}]/.test(norm)) {
        throw new Error(`serve-config: refusing injectable root ${JSON.stringify(p)}`);
    }
    return `"${norm}"`;
}

function assertPort(port: number, which: string): void {
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error(`serve-config: invalid ${which} ${JSON.stringify(port)}`);
    }
}

/**
 * The per-site PLAIN-HTTP Caddyfile for a generated serve mode.
 *
 * The global block disables three Caddy defaults that only make sense for a
 * SINGLE, API-managed Caddy — and every hostServe site spawns its OWN:
 *   - `auto_https off` — the `.gen` front door owns TLS; the site is plain http on
 *     `sitePort` (loopback) and the front door proxies to it.
 *   - `admin off` — Caddy's admin API binds `127.0.0.1:2019` by DEFAULT, so a
 *     SECOND per-site Caddy died with "listen tcp 127.0.0.1:2019: bind: address
 *     already in use" and never started (two static/php sites could not run at
 *     once). Genie drives these Caddys through hostSpawn, never the API, so it is
 *     off — which frees the port and lets any number of sites run.
 *   - `persist_config off` — with the API off there is nothing to persist, and it
 *     stops every per-site Caddy racing to overwrite one shared autosave.json.
 */
export function serveCaddyfile(opts: { sitePort: number; serve: SiteServe }): string {
    assertPort(opts.sitePort, 'site port');
    const root = quoteRoot(opts.serve.root);
    const body: string[] = [`\troot * ${root}`];
    if (opts.serve.kind === 'static') {
        // SPA: an unmatched path serves index.html so a client-side route (deep
        // link, refresh) resolves instead of 404ing — the exact `try_files` an
        // agent otherwise writes by hand.
        if (opts.serve.spa) body.push('\ttry_files {path} /index.html');
        body.push('\tfile_server');
    } else {
        assertPort(opts.serve.fcgiPort, 'fcgi port');
        // `php_fastcgi` is the FRONT CONTROLLER only: it rewrites an unmatched
        // path to index.php and proxies *.php to the worker. It does NOT serve
        // static files — Caddy's own Laravel example pairs it with `file_server`
        // for exactly that reason, and this comment used to claim otherwise
        // (genie#225).
        //
        // Without the file server a request for /build/assets/app.js matched no
        // handler at all: Caddy answered 200 with an EMPTY body and NO
        // Content-Type, with the file sitting right there on disk. Chrome enforces
        // a JS MIME type for <script type="module">, so every Vite/Inertia site
        // served this way rendered blank while its markup and Inertia props looked
        // perfect — which reads as an app bug until you check response headers.
        body.push(`\tphp_fastcgi 127.0.0.1:${opts.serve.fcgiPort}`);
        // AFTER php_fastcgi, so the front controller gets first refusal and
        // anything it does not claim is served from disk with a real Content-Type.
        body.push(`\tfile_server`);
    }
    return [
        '{',
        '\tadmin off',
        '\tpersist_config off',
        '\tauto_https off',
        '}',
        `:${opts.sitePort} {`,
        ...body,
        '}',
        '',
    ].join('\n');
}

/**
 * The PHP FastCGI worker command: `<php-cgi> -b 127.0.0.1:<port>` runs php-cgi as
 * a FastCGI server. `php-cgi` ships with PHP on every OS (unlike `php-fpm`, which
 * is Unix-only), so this is the portable worker Caddy's `php_fastcgi` connects to.
 *
 * `phpCgiExe` is an ABSOLUTE path, resolved from the site's toolchain version
 * (`engine-resolve.ts`) — never a bare name. A bare `php-cgi` is genie#206
 * itself: PATH on the reporting machine held only Herd's `php.bat` shim (the real
 * binaries sat one directory down in `bin/php84`), and because a win32 spawn goes
 * through a shell, the missing binary still produced a pid. The worker was dead,
 * the start reported success, and the site said "Serving." while every request
 * 502'd. So a name with no directory in it is refused HERE too, where any future
 * caller must walk past it.
 */
export function phpFastcgiWorkerCommand(phpCgiExe: string, fcgiPort: number): string[] {
    if (typeof phpCgiExe !== 'string' || phpCgiExe.length === 0) {
        throw new Error('serve-config: missing php-cgi executable');
    }
    if (!/[\\/]/.test(phpCgiExe)) {
        throw new Error(
            `serve-config: refusing a bare php-cgi name ${JSON.stringify(phpCgiExe)} — the FastCGI worker must be a resolved path (genie#207)`,
        );
    }
    assertPort(fcgiPort, 'fcgi port');
    return [phpCgiExe, '-b', `127.0.0.1:${fcgiPort}`];
}

/**
 * Run Genie's bundled Caddy in the FOREGROUND against a per-site config. `run`
 * (not the front door's detached `start`): this Caddy IS the host process Genie
 * tracks for the site, so hostSpawn owns its lifecycle exactly like a repo's own
 * dev server.
 */
export function caddyServeArgv(caddyBin: string, configPath: string): string[] {
    return [caddyBin, 'run', '--config', configPath, '--adapter', 'caddyfile'];
}
