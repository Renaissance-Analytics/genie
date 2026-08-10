import { describe, expect, it } from 'vitest';
import { serveCaddyfile, phpFastcgiWorkerCommand, caddyServeArgv } from '../serve-config';

/**
 * Genie owns the web-server config so an AGENT never writes one (the owner's
 * screenshot: an agent hand-rolling `printf "server { … try_files … }" > default.conf;
 * exec nginx`). An agent declares a SERVE MODE and Genie renders the Caddyfile:
 *   - `static` — serve a built directory, with SPA fallback to index.html;
 *   - `php`    — serve `public/` and hand PHP to a FastCGI worker.
 * Every mode is a plain-http listener on a loopback port; the `.gen` front door
 * adds TLS, so this is `auto_https off`. Reverse-proxy (a repo's own dev server /
 * a service) is the OTHER path and needs no generated config at all.
 */
describe('serveCaddyfile — static', () => {
    it('serves a built directory over file_server (no SPA fallback when spa=false)', () => {
        const cf = serveCaddyfile({
            sitePort: 5321,
            serve: { kind: 'static', root: '/repos/imp-wallet/dist', spa: false },
        });
        expect(cf).toContain(':5321 {');
        expect(cf).toContain('root * "/repos/imp-wallet/dist"');
        expect(cf).toContain('file_server');
        expect(cf).not.toContain('try_files');
        expect(cf).toContain('auto_https off');
    });

    it('falls back to index.html for an SPA so client-side routes resolve', () => {
        const cf = serveCaddyfile({
            sitePort: 5321,
            serve: { kind: 'static', root: '/repos/imp-ledger/dashboard/dist', spa: true },
        });
        // The exact thing the agent hand-rolled: unmatched path -> index.html.
        expect(cf).toContain('try_files {path} /index.html');
        expect(cf).toContain('file_server');
    });

    it('normalises a Windows root and refuses an injectable one', () => {
        expect(
            serveCaddyfile({ sitePort: 1, serve: { kind: 'static', root: 'C:\\r\\dist', spa: false } }),
        ).toContain('root * "C:/r/dist"');
        expect(() =>
            serveCaddyfile({ sitePort: 1, serve: { kind: 'static', root: 'a"\n}', spa: false } }),
        ).toThrow();
    });
});

describe('serveCaddyfile — php', () => {
    it('serves public/ and routes PHP to the FastCGI worker (plain http)', () => {
        const cf = serveCaddyfile({
            sitePort: 5321,
            serve: { kind: 'php', root: '/repos/moic/public', fcgiPort: 5322 },
        });
        expect(cf).toContain('root * "/repos/moic/public"');
        expect(cf).toContain('php_fastcgi 127.0.0.1:5322');
        expect(cf).toContain('auto_https off');
        expect(cf).not.toContain('file_server'); // php_fastcgi adds its own file server
    });
});

describe('phpFastcgiWorkerCommand', () => {
    it('runs php-cgi as a FastCGI server bound to the worker port (portable — ships with PHP)', () => {
        expect(phpFastcgiWorkerCommand(5322)).toEqual(['php-cgi', '-b', '127.0.0.1:5322']);
    });
});

describe('caddyServeArgv', () => {
    it('runs Genie\u2019s bundled Caddy in the FOREGROUND against a per-site config', () => {
        // Foreground `run` (not `start`): this Caddy IS the host process Genie tracks
        // for the site, so hostSpawn owns its lifecycle like any other dev server.
        expect(caddyServeArgv('/opt/genie/caddy', '/cfg/web.caddyfile')).toEqual([
            '/opt/genie/caddy',
            'run',
            '--config',
            '/cfg/web.caddyfile',
            '--adapter',
            'caddyfile',
        ]);
    });
});
