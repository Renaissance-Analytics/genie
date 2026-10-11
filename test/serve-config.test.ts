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

    it('static: bind 127.0.0.1:<port>, root inside the repo, file_server; SPA adds the index.html fallback', () => {
        const plain = serveCaddyfile({ sitePort: 4101, repoPath: '/repo', serve: { mode: 'static', root: 'dist', spa: false } })!;
        expect(plain).toContain('127.0.0.1:4101');
        expect(plain).toContain('root * /repo/dist');
        expect(plain).toContain('file_server');
        expect(plain).not.toContain('try_files');

        const spa = serveCaddyfile({ sitePort: 4101, repoPath: '/repo', serve: { mode: 'static', root: 'dist', spa: true } })!;
        expect(spa).toContain('try_files {path} /index.html');
    });

    it('php: public/ behind php_fastcgi on the worker port', () => {
        const php = serveCaddyfile({ sitePort: 4101, repoPath: '/repo', serve: { mode: 'php', root: 'public', fcgiPort: 4102 } })!;
        expect(php).toContain('root * /repo/public');
        expect(php).toContain('php_fastcgi 127.0.0.1:4102');
        expect(php).toContain('file_server');
    });

    it('never binds beyond loopback, and refuses a root that escapes the repo', () => {
        const out = serveCaddyfile({ sitePort: 4101, repoPath: '/repo', serve: { mode: 'static', root: 'dist', spa: true } })!;
        // A bare `:4101 {` is an all-interfaces bind; only `127.0.0.1:4101 {` may appear.
        expect(out).not.toMatch(/0\.0\.0\.0|(^|[^0-9.]):4101\s*\{/m);
        expect(() => serveCaddyfile({ sitePort: 4101, repoPath: '/repo', serve: { mode: 'static', root: '../etc', spa: false } })).toThrow(/inside the repo/);
        expect(() => serveCaddyfile({ sitePort: 4101, repoPath: '/repo', serve: { mode: 'static', root: '/etc', spa: false } })).toThrow(/inside the repo/);
    });
});

describe('the .gen host name', () => {
    it('is the site name lower-cased under .gen, and refuses anything that is not a hostname label', () => {
        expect(genHost('Tynn')).toBe('tynn.gen');
        expect(genHost('my-site2')).toBe('my-site2.gen');
        for (const bad of ['', 'a b', 'x.y', '-lead', 'trail-', 'a'.repeat(64)]) expect(() => genHost(bad)).toThrow();
    });
});
