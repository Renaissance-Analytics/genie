/**
 * PURE. FrankenPHP as a way Genie serves a PHP site (genie#668).
 *
 * FrankenPHP is Caddy with PHP compiled in: ONE process, threaded, with no
 * FastCGI hop and no separate worker to lose. It sits beside the php-cgi serve
 * mode rather than replacing it — the owner's decision was "offer both" — and it
 * runs the PHP it embeds, which the official binaries fix at one line.
 *
 * So the PHP a repo asks for still decides (owner: "projects still get to set
 * what version of php it uses … read directly from composer"): a repo whose
 * composer.json excludes the embedded PHP is refused, naming the serve mode that
 * can run it, never started on a PHP it did not ask for. Genie-built FrankenPHP
 * per PHP line is the follow-up that lifts that refusal (#668).
 *
 * Facts below were read off the real v1.12.7 release, not assumed:
 *   `frankenphp version` → "FrankenPHP 1.12.7 PHP 8.5.10 Caddy v2.11.4 h1:…"
 *   the Windows zip is a full thread-safe PHP 8.5.10 — php8ts.dll, php.exe,
 *   php-cgi.exe, ext/ — and loads NO php.ini, so without one Genie writes, the
 *   extensions a Laravel app needs (mbstring, openssl, pdo_pgsql…) never load.
 */

import { HOST_CADDY_HTTPS_PORT } from './host-caddyfile';
import { PHP_VARIABLES_ORDER } from './toolchain-versions';
import { composerConstraintAllows, type ComposerPhp } from './composer-php';

/** The FrankenPHP release Genie installs. */
export const FRANKENPHP_VERSION = '1.12.7';
/** The PHP that release embeds — what a repo's composer.json is checked against
 *  before anything is downloaded. The installed binary is asked again after. */
export const FRANKENPHP_PHP_VERSION = '8.5.10';

export interface FrankenphpAsset {
    url: string;
    /** `zip` on Windows (FrankenPHP + PHP's DLLs); a single `binary` elsewhere. */
    artifact: 'zip' | 'binary';
    /** The executable's file name inside the install directory. */
    exe: string;
}

/** The official binary for a machine, or undefined where none is published. */
export function frankenphpAssetFor(ctx: { os: string; arch?: string }): FrankenphpAsset | undefined {
    const base = `https://github.com/php/frankenphp/releases/download/v${FRANKENPHP_VERSION}`;
    const arm = ctx.arch === 'arm64';
    if (ctx.os === 'win32') {
        // x86_64 only: the project publishes no Windows arm64 build.
        if (arm) return undefined;
        return { url: `${base}/frankenphp-windows-x86_64.zip`, artifact: 'zip', exe: 'frankenphp.exe' };
    }
    if (ctx.os === 'linux') {
        return { url: `${base}/frankenphp-linux-${arm ? 'aarch64' : 'x86_64'}`, artifact: 'binary', exe: 'frankenphp' };
    }
    if (ctx.os === 'darwin') {
        return { url: `${base}/frankenphp-mac-${arm ? 'arm64' : 'x86_64'}`, artifact: 'binary', exe: 'frankenphp' };
    }
    return undefined;
}

/** What `frankenphp version` says it is, or null when it does not say. */
export function parseFrankenphpVersion(stdout: string): { frankenphp: string; php: string } | null {
    const m = /FrankenPHP\s+v?(\d+\.\d+\.\d+)\s+PHP\s+(\d+\.\d+\.\d+)/.exec(stdout);
    return m ? { frankenphp: m[1]!, php: m[2]! } : null;
}

/**
 * Why FrankenPHP cannot serve this repo, or null when it can.
 *
 * Refused rather than started: a site quietly running on a PHP its composer.json
 * excludes produces a bug report about the APP, from someone with no reason to
 * suspect the runtime — the failure genie#207 exists to prevent.
 */
export function frankenphpRefusal(requires: ComposerPhp | null, phpVersion: string): string | null {
    if (!requires || composerConstraintAllows(requires.constraint, phpVersion)) return null;
    return (
        `This repo's composer.json requires PHP ${requires.constraint} (\`${requires.source}\`), and FrankenPHP runs the PHP it embeds, ` +
        `${phpVersion}. Serve this site with the \`php\` mode instead — it runs the PHP the repo asks for.`
    );
}

/** A path for a Caddyfile string: forward slashes, quoted, never injectable. */
function quotePath(p: string, what: string): string {
    if (typeof p !== 'string' || p.length === 0) throw new Error(`frankenphp: missing ${what}`);
    const norm = p.replace(/\\/g, '/');
    if (/["\n\r{}]/.test(norm)) throw new Error(`frankenphp: refusing injectable ${what} ${JSON.stringify(p)}`);
    return `"${norm}"`;
}

/**
 * The per-site Caddyfile FrankenPHP runs.
 *
 * Plain http on loopback's allocated port, like Genie's per-site Caddy: the
 * `.gen` front door owns TLS. And for the same reason as that Caddy, PHP is TOLD
 * it is behind https — derived from its own plain connection it would conclude
 * http, and every framework then emits `http://<name>.gen` links (the
 * mixed-content bug the FastCGI path already fixed). There is no second proxy
 * hop here, so the front door's X-Forwarded-Proto reaches PHP untouched.
 *
 * `php_server` is the front controller AND the static file server; leaving its
 * file server on is what serves `/build/assets/*.js` with a real Content-Type
 * (genie#225).
 */
export function frankenphpCaddyfile(opts: { sitePort: number; root: string; uploadTmpDir: string }): string {
    if (!Number.isInteger(opts.sitePort) || opts.sitePort < 1 || opts.sitePort > 65535) {
        throw new Error(`frankenphp: invalid site port ${JSON.stringify(opts.sitePort)}`);
    }
    const root = quotePath(opts.root, 'root');
    const uploads = quotePath(opts.uploadTmpDir, 'upload_tmp_dir');
    return [
        '{',
        '\tadmin off',
        '\tpersist_config off',
        '\tauto_https off',
        '\tfrankenphp {',
        // Where a multipart upload is spooled (genie#534) — not Genie's own temp.
        `\t\tphp_ini upload_tmp_dir ${uploads}`,
        // So the service env is readable as $_ENV too (genie#539).
        `\t\tphp_ini variables_order ${PHP_VARIABLES_ORDER}`,
        '\t}',
        '}',
        `:${opts.sitePort} {`,
        `\troot * ${root}`,
        '\tencode zstd br gzip',
        '\tphp_server {',
        '\t\tenv HTTPS on',
        `\t\tenv SERVER_PORT ${HOST_CADDY_HTTPS_PORT}`,
        '\t\tenv REQUEST_SCHEME https',
        '\t}',
        '}',
        '',
    ].join('\n');
}

/** Run a generated Caddyfile in the foreground — the process Genie tracks. */
export function frankenphpRunArgv(exe: string, configPath: string): string[] {
    return [exe, 'run', '--config', configPath, '--adapter', 'caddyfile'];
}
