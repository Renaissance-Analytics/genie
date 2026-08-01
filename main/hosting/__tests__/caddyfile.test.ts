import { describe, expect, it } from 'vitest';
import { caddyPath, globalBlock, quote, renderCaddyfile, siteBlock } from '../caddyfile';
import type { CaddyfileOptions } from '../caddyfile';
import type { HostedSite } from '../types';

/**
 * The Caddyfile is the FrankenPHP adapter's entire configuration surface, so a
 * bug here is a site that serves the wrong directory, binds an address we did
 * not intend, or fails to start at all. Three of these assertions defend
 * findings from the P1 spike rather than guesses:
 *
 *  - `bind 127.0.0.1` — without it Caddy binds every interface. The spike's
 *    hand-written Caddyfile omitted it and Caddy logged `addr: ":8443"`, i.e.
 *    the "local preview" was reachable from the LAN.
 *  - `auto_https disable_redirects` — also omitted in the spike, and Caddy
 *    silently claimed port **80** for an HTTP→HTTPS redirect server nobody
 *    asked for. On a developer machine that is someone else's port.
 *  - `tls internal` — Caddy only auto-selects its internal issuer for
 *    `localhost`-ish names. A `.test` vhost is treated as public and Caddy will
 *    attempt an ACME order that cannot possibly validate.
 */

const OPTS: CaddyfileOptions = {
    port: 20431,
    storageDir: 'C:\\Users\\me\\AppData\\Genie\\caddy',
};

const php: HostedSite = {
    id: 'site-1',
    hostname: 'Tynn.Test',
    root: 'C:\\Users\\me\\repos\\tynn\\public',
    kind: 'php',
};

const staticSite: HostedSite = {
    id: 'site-2',
    hostname: 'fancy.test',
    root: '/home/me/repos/fancy/dist',
    kind: 'static',
};

describe('quote / caddyPath', () => {
    it('leaves a plain token unquoted', () => {
        expect(quote('index.php')).toBe('index.php');
    });

    it('quotes and escapes tokens containing whitespace or quotes', () => {
        expect(quote('my app')).toBe('"my app"');
        expect(quote('say "hi"')).toBe('"say \\"hi\\""');
    });

    it('normalises Windows separators BEFORE quoting', () => {
        // `\U` would be read as an escape by Caddy; forward slashes are accepted
        // on every OS, so the same generator is correct on all three.
        expect(caddyPath('C:\\Users\\me\\public')).toBe('C:/Users/me/public');
        expect(caddyPath('C:\\Program Files\\app')).toBe('"C:/Program Files/app"');
    });
});

describe('globalBlock', () => {
    it('disables the admin API', () => {
        // Caddy's admin endpoint defaults to localhost:2019 and can rewrite the
        // running config — any local process could re-point a hosted site.
        expect(globalBlock(OPTS)).toContain('admin off');
    });

    it('disables the HTTP->HTTPS redirect server so it never claims port 80', () => {
        expect(globalBlock(OPTS)).toContain('auto_https disable_redirects');
    });

    it('pins Caddy storage so the local CA root survives restarts', () => {
        expect(globalBlock(OPTS)).toContain(
            'storage file_system C:/Users/me/AppData/Genie/caddy',
        );
    });

    it('skips trust-store installation by default', () => {
        // P1 must never write a root CA into the OS trust store behind the
        // user's back; that is P2, behind explicit consent.
        expect(globalBlock(OPTS)).toContain('skip_install_trust');
    });

    it('allows trust installation to be opted into explicitly', () => {
        expect(globalBlock({ ...OPTS, skipInstallTrust: false })).not.toContain(
            'skip_install_trust',
        );
    });

    it('enables the frankenphp module', () => {
        expect(globalBlock(OPTS)).toContain('frankenphp');
    });
});

describe('siteBlock', () => {
    it('addresses the site at its stable https origin', () => {
        expect(siteBlock(php, OPTS)).toContain('https://tynn.test:20431 {');
    });

    it('binds loopback only', () => {
        expect(siteBlock(php, OPTS)).toContain('bind 127.0.0.1');
    });

    it('states local TLS rather than relying on Caddy to infer it', () => {
        expect(siteBlock(php, OPTS)).toContain('tls internal');
    });

    it('serves the document root with normalised separators', () => {
        expect(siteBlock(php, OPTS)).toContain('root C:/Users/me/repos/tynn/public');
    });

    it('routes a php site through php_server with a front-controller fallback', () => {
        const out = siteBlock(php, OPTS);
        expect(out).toContain('php_server {');
        expect(out).toContain('try_files {path} index.php');
        expect(out).not.toContain('file_server');
    });

    it('honours a custom front controller', () => {
        expect(siteBlock({ ...php, index: 'app.php' }, OPTS)).toContain(
            'try_files {path} app.php',
        );
    });

    it('serves a static site with an SPA fallback and no PHP', () => {
        const out = siteBlock(staticSite, OPTS);
        expect(out).toContain('try_files {path} {path}/ /index.html');
        expect(out).toContain('file_server');
        expect(out).not.toContain('php_server');
    });

    it('emits env pairs inside php_server', () => {
        const out = siteBlock({ ...php, env: { APP_ENV: 'local', X: 'a b' } }, OPTS);
        expect(out).toContain('env APP_ENV local');
        expect(out).toContain('env X "a b"');
    });

    it('emits a worker block only when the site opts in', () => {
        expect(siteBlock(php, OPTS)).not.toContain('worker {');
        const out = siteBlock(
            {
                ...php,
                worker: { file: 'frankenphp-worker.php', num: 4, watch: ['C:\\app\\**\\*.php'] },
            },
            OPTS,
        );
        expect(out).toContain('worker {');
        expect(out).toContain('file frankenphp-worker.php');
        expect(out).toContain('num 4');
        expect(out).toContain('watch C:/app/**/*.php');
    });
});

describe('renderCaddyfile', () => {
    it('emits the global block before the site block', () => {
        const out = renderCaddyfile(php, OPTS);
        expect(out.indexOf('admin off')).toBeLessThan(out.indexOf('https://tynn.test'));
        expect(out.endsWith('\n')).toBe(true);
    });

    it('never leaves a raw backslash for Caddy to read as an escape', () => {
        expect(renderCaddyfile(php, OPTS)).not.toMatch(/[^\\]\\[A-Za-z]/);
    });
});
