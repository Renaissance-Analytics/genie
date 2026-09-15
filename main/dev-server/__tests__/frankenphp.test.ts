import { describe, expect, it } from 'vitest';
import {
    FRANKENPHP_PHP_VERSION,
    FRANKENPHP_VERSION,
    frankenphpAssetFor,
    frankenphpCaddyfile,
    frankenphpRefusal,
    frankenphpRunArgv,
    parseFrankenphpVersion,
} from '../frankenphp';

/**
 * FRANKENPHP AS A WAY GENIE SERVES A PHP SITE (genie#668).
 *
 * FrankenPHP is Caddy with PHP compiled in: one process, threaded, no FastCGI
 * hop and no worker to lose. The owner: "why are we still using fast-cgi? Where
 * is the support for FrankenPHP like I asked for?" — and, on how: offer both, use
 * the official binaries now (they embed PHP 8.5), and refuse a repo whose
 * composer.json excludes that PHP rather than run it on the wrong one.
 *
 * Facts pinned below were read off the real v1.12.7 release:
 *   `frankenphp version` → "FrankenPHP 1.12.7 PHP 8.5.10 Caddy v2.11.4 h1:…"
 *   the Windows zip is a full thread-safe PHP 8.5.10 (php8ts.dll + ext/) and
 *   loads NO php.ini — so Genie writes one, or mbstring/openssl/pdo never load.
 */

describe('frankenphpAssetFor — the official binary for this machine', () => {
    const base = `https://github.com/php/frankenphp/releases/download/v${FRANKENPHP_VERSION}`;

    it('names the Windows zip, which carries PHP itself beside frankenphp.exe', () => {
        expect(frankenphpAssetFor({ os: 'win32', arch: 'x64' })).toEqual({
            url: `${base}/frankenphp-windows-x86_64.zip`,
            artifact: 'zip',
            exe: 'frankenphp.exe',
        });
    });

    it('names the single static binary on Linux and macOS, per architecture', () => {
        expect(frankenphpAssetFor({ os: 'linux', arch: 'x64' })).toEqual({
            url: `${base}/frankenphp-linux-x86_64`,
            artifact: 'binary',
            exe: 'frankenphp',
        });
        expect(frankenphpAssetFor({ os: 'linux', arch: 'arm64' })?.url).toBe(`${base}/frankenphp-linux-aarch64`);
        expect(frankenphpAssetFor({ os: 'darwin', arch: 'arm64' })?.url).toBe(`${base}/frankenphp-mac-arm64`);
        expect(frankenphpAssetFor({ os: 'darwin', arch: 'x64' })?.url).toBe(`${base}/frankenphp-mac-x86_64`);
    });

    it('offers nothing where the project publishes nothing, instead of a URL that 404s', () => {
        expect(frankenphpAssetFor({ os: 'win32', arch: 'arm64' })).toBeUndefined();
        expect(frankenphpAssetFor({ os: 'freebsd', arch: 'x64' })).toBeUndefined();
    });
});

describe('parseFrankenphpVersion — what the installed binary says it is', () => {
    it('reads FrankenPHP\'s version and the PHP it embeds from the real output', () => {
        expect(
            parseFrankenphpVersion('FrankenPHP 1.12.7 PHP 8.5.10 Caddy v2.11.4 h1:XKxkMTgNSizEvKG6QHue6cAsFOteU2qA61w2tKkCWi0=\n'),
        ).toEqual({ frankenphp: '1.12.7', php: '8.5.10' });
    });

    it('is null for anything else — an install that cannot say what it is has not proven itself', () => {
        expect(parseFrankenphpVersion('')).toBeNull();
        expect(parseFrankenphpVersion('v2.11.4 h1:abc')).toBeNull();
    });

    it('pins the PHP the current release embeds', () => {
        expect(FRANKENPHP_PHP_VERSION).toBe('8.5.10');
    });
});

describe('frankenphpRefusal — a repo FrankenPHP\'s PHP cannot run', () => {
    it('allows a repo whose composer.json admits the embedded PHP', () => {
        expect(frankenphpRefusal({ constraint: '^8.3', source: 'require.php' }, '8.5.10')).toBeNull();
        // A repo that states nothing has nothing to violate.
        expect(frankenphpRefusal(null, '8.5.10')).toBeNull();
    });

    it('refuses one that excludes it, naming the constraint, the PHP it would get, and the way that works', () => {
        const why = frankenphpRefusal({ constraint: '>=8.2 <8.5', source: 'require.php' }, '8.5.10');
        expect(why).toContain('>=8.2 <8.5');
        expect(why).toContain('require.php');
        expect(why).toContain('8.5.10');
        expect(why).toMatch(/php/);
    });

    it('refuses a platform pin to another line — the lock file was resolved for that PHP', () => {
        expect(frankenphpRefusal({ constraint: '8.3.*', source: 'config.platform.php' }, '8.5.10')).toContain(
            'config.platform.php',
        );
    });
});

describe('frankenphpCaddyfile — how a site is served', () => {
    const config = frankenphpCaddyfile({
        sitePort: 51234,
        root: 'C:\\work\\shop\\public',
        uploadTmpDir: 'C:\\gd\\host-site-uploads\\abc',
    });

    it('is plain http on the allocated port, with no admin API and no automatic https', () => {
        expect(config).toContain(':51234 {');
        expect(config).toMatch(/\tadmin off/);
        expect(config).toMatch(/\tauto_https off/);
    });

    it('serves the document root through php_server — the front controller AND the static files', () => {
        expect(config).toContain('root * "C:/work/shop/public"');
        expect(config).toMatch(/\tphp_server \{/);
        // php_server includes its own file server; turning it off would be the
        // empty-200 asset bug (genie#225) all over again.
        expect(config).not.toContain('file_server off');
    });

    it('tells PHP it is behind https, exactly as the FastCGI path does — or every link is http://', () => {
        expect(config).toMatch(/\t\tenv HTTPS on/);
        expect(config).toMatch(/\t\tenv SERVER_PORT 443/);
        expect(config).toMatch(/\t\tenv REQUEST_SCHEME https/);
    });

    it('states the upload spool and $_ENV population in PHP\'s own config (genie#534, genie#539)', () => {
        expect(config).toContain('php_ini upload_tmp_dir "C:/gd/host-site-uploads/abc"');
        expect(config).toContain('php_ini variables_order EGPCS');
    });

    it('refuses an injectable root or upload directory, and an invalid port', () => {
        expect(() => frankenphpCaddyfile({ sitePort: 51234, root: 'x"}\nevil', uploadTmpDir: '/u' })).toThrow();
        expect(() => frankenphpCaddyfile({ sitePort: 51234, root: '/r', uploadTmpDir: 'u"\n' })).toThrow();
        expect(() => frankenphpCaddyfile({ sitePort: 0, root: '/r', uploadTmpDir: '/u' })).toThrow();
    });
});

describe('frankenphpRunArgv', () => {
    it('runs the generated Caddyfile in the foreground, like Genie\'s own Caddy', () => {
        expect(frankenphpRunArgv('/gd/toolchain/frankenphp/1.12.7/frankenphp', '/cfg/a.caddyfile')).toEqual([
            '/gd/toolchain/frankenphp/1.12.7/frankenphp',
            'run',
            '--config',
            '/cfg/a.caddyfile',
            '--adapter',
            'caddyfile',
        ]);
    });
});
