import { describe, expect, it } from 'vitest';
import { detectDevServer, detectStaticServe, genHost, serveCaddyfile, type RepoFacts } from '../src/core/serve-config.js';

/**
 * HOSTED `.gen` SITES (§6.6) — the pure half: what a repo serves, and the web-server config Genie
 * renders for it. **Agents never write a web-server config.** Three serve modes, the same split
 * every local-hosting tool makes: `proxy` (the repo's own dev server, or any port), `static` (a
 * built directory, optionally SPA), `php` (public/ behind a FastCGI worker — PHP is the one
 * mainstream language that is not its own web server).
 */

const facts = (over: Partial<RepoFacts>): RepoFacts => ({ files: [], packageScripts: {}, ...over });

describe('the dev server a repo runs', () => {
    it('Laravel → artisan serve on the allocated port', () => {
        expect(detectDevServer(facts({ files: ['artisan', 'composer.json'] }))).toEqual({
            stack: 'laravel',
            command: 'php artisan serve --host=127.0.0.1 --port={port}',
        });
    });

    it('a package.json dev script → npm run dev with the port passed through', () => {
        expect(detectDevServer(facts({ files: ['package.json'], packageScripts: { dev: 'vite' } }))).toEqual({
            stack: 'node',
            command: 'npm run dev -- --port {port}',
        });
        // `start` is the fallback script name; `build` alone is not a dev server.
        expect(detectDevServer(facts({ files: ['package.json'], packageScripts: { start: 'node server.js' } }))).toMatchObject({ command: 'npm run start -- --port {port}' });
        expect(detectDevServer(facts({ files: ['package.json'], packageScripts: { build: 'tsc' } }))).toBeNull();
    });

    it('Django → runserver; Go → go run .', () => {
        expect(detectDevServer(facts({ files: ['manage.py'] }))).toEqual({ stack: 'django', command: 'python manage.py runserver 127.0.0.1:{port}' });
        expect(detectDevServer(facts({ files: ['go.mod', 'main.go'] }))).toEqual({ stack: 'go', command: 'go run .' });
    });

    it('nothing recognisable → null, never an invented command', () => {
        expect(detectDevServer(facts({ files: ['README.md'] }))).toBeNull();
    });
});

describe('a built directory a repo could serve static', () => {
    it('dist/build/out with an index.html, in a repo with NO dev server → static SPA', () => {
        expect(detectStaticServe(facts({ files: ['dist/index.html', 'dist/app.js'] }))).toEqual({ mode: 'static', root: 'dist', spa: true });
        expect(detectStaticServe(facts({ files: ['build/index.html'] }))).toEqual({ mode: 'static', root: 'build', spa: true });
    });

    it('a repo you DEVELOP is left to its dev command; a bare root index.html is not served', () => {
        expect(detectStaticServe(facts({ files: ['dist/index.html', 'package.json'], packageScripts: { dev: 'vite' } }))).toBeNull();
        expect(detectStaticServe(facts({ files: ['index.html'] }))).toBeNull();
    });
});

describe('the Caddyfile Genie renders — per site, loopback only', () => {
    it('proxy mode needs no generated config at all', () => {
        expect(serveCaddyfile({ sitePort: 4101, serve: { mode: 'proxy' } })).toBeNull();
    });

    it('static: its port bound to 127.0.0.1, root inside the repo, file_server; SPA adds the index.html fallback', () => {
        const plain = serveCaddyfile({ sitePort: 4101, repoPath: '/repo', serve: { mode: 'static', root: 'dist', spa: false } })!;
        expect(plain).toContain('http://:4101 {');
        expect(plain).toContain('bind 127.0.0.1');
        expect(plain).toContain('root * /repo/dist');
        expect(plain).toContain('file_server');
        expect(plain).not.toContain('try_files');

        const spa = serveCaddyfile({ sitePort: 4101, repoPath: '/repo', serve: { mode: 'static', root: 'dist', spa: true } })!;
        expect(spa).toContain('try_files {path} /index.html');
    });

    it('php: public/ behind php_fastcgi on the worker port', () => {
        const php = serveCaddyfile({ sitePort: 4101, repoPath: '/repo', serve: { mode: 'php', root: 'public', fcgiPort: 4102 } })!;
        expect(php).toContain('root * /repo/public');
        expect(php).toContain('php_fastcgi 127.0.0.1:4102 {');
        // The request is HTTPS to PHP (moic.gen rendered blank: http:// asset links on an https page). COUNTED: exactly
        // one of each, inside the php_fastcgi block.
        const block = /php_fastcgi 127\.0\.0\.1:4102 \{([\s\S]*?)\n\t\}/.exec(php)?.[1] ?? '';
        expect(block.match(/^\t\tenv HTTPS on$/gm) ?? []).toHaveLength(1);
        expect(block.match(/^\t\tenv REQUEST_SCHEME https$/gm) ?? []).toHaveLength(1);
        expect(block.match(/^\t\tenv SERVER_PORT 443$/gm) ?? []).toHaveLength(1);
        // CONTROL: a static site has no PHP and so no such block.
        expect(serveCaddyfile({ sitePort: 4101, repoPath: '/repo', serve: { mode: 'static', root: 'dist', spa: false } })).not.toContain('env HTTPS');
        expect(php).toContain('file_server');
    });

    // The owner, 2026-10-14, on beta.24: "Zero *.gen sites are being served". Measured on his machine: one site's own
    // Caddy (127.0.0.1:4109) also held 0.0.0.0:80 and 127.0.0.1:2019 — automatic HTTPS opens a redirect server on :80
    // and every Caddy opens its admin API on :2019 — so the other four PHP sites and Genie's front door could not start.
    // And a bare `127.0.0.1:4109` address is served over HTTPS, while the front door proxies to it in plain HTTP.
    it('a site’s Caddy holds ITS port and nothing else: auto_https off, admin off, an explicit http:// address', () => {
        for (const serve of [{ mode: 'static', root: 'dist', spa: false }, { mode: 'php', root: 'public', fcgiPort: 4102 }] as const) {
            const out = serveCaddyfile({ sitePort: 4101, repoPath: '/repo', serve })!;
            const globals = /^\{([\s\S]*?)\n\}/.exec(out)?.[1] ?? '';
            expect(globals).toMatch(/^\s*auto_https off\s*$/m);
            expect(globals).toMatch(/^\s*admin off\s*$/m);
            // COUNTED: exactly one site block, plain HTTP on its port, answering ANY Host (the front door forwards the
            // site's own name), bound to loopback.
            expect(out.match(/^http:\/\/:4101 \{$/gm) ?? []).toHaveLength(1);
            expect(out.match(/^\s*bind 127\.0\.0\.1$/gm) ?? []).toHaveLength(1);
            // A host in the address is a Host matcher: it answered the front door's `Host: <name>.gen` with an empty 200.
            expect(out).not.toMatch(/^(http:\/\/)?127\.0\.0\.1:4101 \{$/m);
        }
    });

    it('never binds beyond loopback, and refuses a root that escapes the repo', () => {
        const out = serveCaddyfile({ sitePort: 4101, repoPath: '/repo', serve: { mode: 'static', root: 'dist', spa: true } })!;
        // The address names no interface, so the `bind` line is what keeps it on loopback: exactly one, and only that.
        expect(out).not.toMatch(/0\.0\.0\.0/);
        expect(out.match(/^\s*bind\s+\S+$/gm) ?? []).toEqual(['\tbind 127.0.0.1']);
        expect(() => serveCaddyfile({ sitePort: 4101, repoPath: '/repo', serve: { mode: 'static', root: '../etc', spa: false } })).toThrow(/inside the repo/);
        expect(() => serveCaddyfile({ sitePort: 4101, repoPath: '/repo', serve: { mode: 'static', root: '/etc', spa: false } })).toThrow(/inside the repo/);
    });
});

describe('the .gen host name', () => {
    it('CONTROL: a one-label name is what it always was — lower-cased under .gen', () => {
        expect(genHost('Tynn')).toBe('tynn.gen');
        expect(genHost('my-site2')).toBe('my-site2.gen');
    });

    it('S5: one or more labels — Genie 1’s default <site>.<workspace>.gen, and any valid custom a.b.gen; a typed .gen is not doubled', () => {
        // Counted: three multi-label names in, three hosts out, each the full name.
        const hosts = ['web.example', 'API.Docs.Example', 'a.b'].map(genHost);
        expect(hosts).toEqual(['web.example.gen', 'api.docs.example.gen', 'a.b.gen']);
        expect(genHost('web.example.gen')).toBe('web.example.gen');
    });

    it('every label is checked on its own — counted refusals, each naming why', () => {
        const bad = ['', 'a b', 'web..example', '.web', '-lead.example', 'web.trail-', 'web_1.example', `web.${'a'.repeat(64)}`, `${'a.'.repeat(125)}a`];
        const refused = bad.filter((b) => { try { genHost(b); return false; } catch { return true; } });
        expect(refused).toEqual(bad);
        expect(() => genHost('web_1.example')).toThrow(/"web_1" is not a hostname label/);
        expect(() => genHost('web..example')).toThrow(/empty label/);
        expect(() => genHost(`${'a.'.repeat(125)}a`)).toThrow(/longer than the 253/);
    });
});
