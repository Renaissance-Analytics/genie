/**
 * The nginx-style PHP serving primitives — Genie's bundled Caddy in front of a host
 * PHP FastCGI worker, serving the repo's `public/` over `php_fastcgi`. Both run as
 * host processes on allocated loopback ports (reusing the auto-port + routing +
 * readiness the rest of the site manager already has). This is the portable proxy
 * model: no per-OS static build, no new binary — Genie already ships Caddy, and the
 * PHP worker (`php-cgi`) ships with PHP on every OS.
 *
 * TLS is added by the `.gen` front door (the host Caddy on :443, or the in-app
 * carrier), so this per-site listener speaks plain http on `127.0.0.1:<sitePort>`.
 *
 * PURE string/argv builders — deterministically testable, no fs, no spawn.
 */

/** Quote a docroot for a Caddyfile: normalise Windows `\` to `/` (Caddy accepts it
 *  and it dodges quote-escaping), then refuse anything that could break the quotes
 *  or inject a directive. */
function quoteRoot(p: string): string {
    if (typeof p !== 'string' || p.length === 0) {
        throw new Error('php-fastcgi: missing public root');
    }
    const norm = p.replace(/\\/g, '/');
    if (/["\n\r{}]/.test(norm)) {
        throw new Error(`php-fastcgi: refusing injectable root ${JSON.stringify(p)}`);
    }
    return `"${norm}"`;
}

function assertPort(port: number, which: string): void {
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error(`php-fastcgi: invalid ${which} ${JSON.stringify(port)}`);
    }
}

/**
 * A per-site PLAIN-HTTP Caddyfile: serve `publicRoot` on `sitePort`, routing PHP to
 * the FastCGI worker on `fcgiPort` (Caddy's `php_fastcgi` adds the file server +
 * front-controller `try_files` itself). `auto_https off` because the `.gen` front
 * door owns TLS.
 */
export function phpFastcgiCaddyfile(opts: {
    sitePort: number;
    publicRoot: string;
    fcgiPort: number;
}): string {
    assertPort(opts.sitePort, 'site port');
    assertPort(opts.fcgiPort, 'fcgi port');
    const root = quoteRoot(opts.publicRoot);
    return [
        '{',
        '\tauto_https off',
        '}',
        `:${opts.sitePort} {`,
        `\troot * ${root}`,
        `\tphp_fastcgi 127.0.0.1:${opts.fcgiPort}`,
        '}',
        '',
    ].join('\n');
}

/**
 * The PHP FastCGI worker command: `php-cgi -b 127.0.0.1:<port>` runs php-cgi as a
 * FastCGI server. `php-cgi` ships with PHP on every OS (unlike `php-fpm`, which is
 * Unix-only), so this is the portable worker Caddy's `php_fastcgi` connects to.
 */
export function phpFastcgiWorkerCommand(fcgiPort: number): string[] {
    assertPort(fcgiPort, 'fcgi port');
    return ['php-cgi', '-b', `127.0.0.1:${fcgiPort}`];
}
