import { describe, expect, it } from 'vitest';
import { devServerFor, editedSiteEntry, formatLike, readEnvelopeSites, resolveRepoDir, siteEntryFor, siteKeyFor, withSiteEntry, type ServableSite, type UnservableSite } from '../src/core/envelope-sites.js';

/**
 * A WORKSPACE'S SITES AS ITS ENVELOPE DECLARES THEM (§6.6) — the pure half. Each project.json `sites`
 * entry (Genie 1's shape) maps onto what Genie 2 serves, or onto the reason it cannot; writing edits the
 * `sites` key alone, in the file's own style. Fixtures are invented names.
 */

const manifest = (sites: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
    name: 'Acme',
    repos: [
        { name: 'Shop', slug: 'shop', path: 'repos/shop' },
        { name: 'docs-site', path: 'repos/docs-site' },
        { name: 'host', slug: 'host', path: '.' },
        { name: 'deep', slug: 'deep', path: 'apps/deep/' },
    ],
    sites,
    ...extra,
});
const one = (entry: Record<string, unknown>) => readEnvelopeSites(manifest({ k1: entry }))[0]!;
const served = (entry: Record<string, unknown>) => { const s = one(entry); expect(s.ok, (s as UnservableSite).reason).toBe(true); return s as ServableSite; };
const refused = (entry: Record<string, unknown>) => { const s = one(entry); expect(s.ok).toBe(false); return s as UnservableSite; };
const host = { runMode: 'host', kind: 'http', enabled: true };

describe('where `repo` points', () => {
    it('resolves against repos[] by slug, name, path or folder name; "" is the envelope; else Genie 1’s repos/<repo>; never outside', () => {
        const m = manifest({});
        expect(resolveRepoDir(m, 'shop')).toBe('repos/shop');
        expect(resolveRepoDir(m, 'Shop')).toBe('repos/shop');
        expect(resolveRepoDir(m, 'docs-site')).toBe('repos/docs-site');
        expect(resolveRepoDir(m, 'deep')).toBe('apps/deep');
        expect(resolveRepoDir(m, '')).toBe('.');
        expect(resolveRepoDir(m, 'host')).toBe('.');
        expect(resolveRepoDir(m, 'unlisted')).toBe('repos/unlisted');
        expect(resolveRepoDir(m, '../etc')).toBeNull();
        expect(resolveRepoDir(m, 'a/b')).toBeNull();
    });
});

describe('each serve shape', () => {
    it('hostServe php → php with its root; static → static with root and spa', () => {
        expect(served({ ...host, repo: 'shop', name: 'shop', genName: 'shop.gen', hostServe: { mode: 'php', root: 'public' } })).toMatchObject({ name: 'shop', repoDir: 'repos/shop', enabled: true, serve: { mode: 'php', root: 'public' } });
        expect(served({ ...host, repo: 'shop', name: 'x', genName: 'docs.gen', enabled: false, hostServe: { mode: 'static', root: 'dist', spa: true } })).toMatchObject({ name: 'docs', enabled: false, serve: { mode: 'static', root: 'dist', spa: true } });
        expect(served({ ...host, repo: 'shop', genName: 'docs.gen', hostServe: { mode: 'static', root: 'dist' } }).serve).toEqual({ mode: 'static', root: 'dist', spa: false });
    });

    it('a php site’s PHP pin (Genie 1’s hostServe.version) is carried to the site, and written back as it was read', () => {
        expect(served({ ...host, repo: 'shop', genName: 'shop.gen', hostServe: { mode: 'php', root: 'public', version: '8.4' } }).serve).toEqual({ mode: 'php', root: 'public', version: '8.4' });
        // Control: no pin, no version — the PATH PHP.
        expect(served({ ...host, repo: 'shop', genName: 'shop.gen', hostServe: { mode: 'php', root: 'public' } }).serve).toEqual({ mode: 'php', root: 'public' });
        const entry = siteEntryFor(manifest({}), { name: 'shop', repoDir: 'repos/shop', serve: { mode: 'php', root: 'public', version: '8.4.26' } });
        expect(entry).toMatchObject({ ok: true, entry: { hostServe: { mode: 'php', root: 'public', version: '8.4.26' } } });
        expect(served({ ...host, ...(entry as { entry: Record<string, unknown> }).entry }).serve).toEqual({ mode: 'php', root: 'public', version: '8.4.26' });
    });

    it('hostPort → a proxy to a server already listening, nothing started', () => {
        expect(served({ ...host, repo: '', genName: 'legacy.gen', hostPort: 8085 })).toMatchObject({ serve: { mode: 'proxy' }, hostPort: 8085, repoDir: '.' });
    });

    it('a command → the repo’s own dev server, the written port replaced by Genie’s', () => {
        expect(served({ ...host, repo: 'shop', genName: 'api.gen', command: ['php', 'artisan', 'serve', '--host=0.0.0.0', '--port=8091'] }).devServer).toEqual({ stack: 'laravel', command: 'php artisan serve --host=127.0.0.1 --port={port}' });
        expect(served({ ...host, repo: 'shop', genName: 'api.gen', command: ['npm', 'run', 'dev', '--', '--port', '5173'] }).devServer).toEqual({ stack: 'node', command: 'npm run dev -- --port {port}' });
        // Genie 1's pre-rework `serve` argv is read when there is no `command`.
        expect(served({ ...host, repo: 'shop', genName: 'api.gen', serve: ['python', 'manage.py', 'runserver', '0.0.0.0:8000'] }).devServer).toEqual({ stack: 'django', command: 'python manage.py runserver 127.0.0.1:{port}' });
    });

    it('a command that names no port gets Genie 1’s fallback for its stack', () => {
        expect(devServerFor(['php', 'artisan', 'serve'], { framework: 'laravel' })).toEqual({ command: 'php artisan serve --port={port}' });
        expect(devServerFor(['npm', 'run', 'dev'], { framework: 'vite' })).toEqual({ command: 'npm run dev -- --port {port} --strictPort', portEnv: { PORT: '{port}' } });
        expect(devServerFor(['python', 'scripts/dev.py'], {})).toEqual({ command: 'python scripts/dev.py', portEnv: { PORT: '{port}' } });
        // `--port auto` is not a port number and is left alone.
        expect(devServerFor(['srv', '--port', 'auto'], {}).command).toBe('srv --port auto');
    });

    it('argv tokens with spaces are quoted, and a created entry’s command reads back to the same argv', () => {
        const dev = devServerFor(['node', 'my server.js', '--port=1'], {});
        expect(dev.command).toBe('node "my server.js" --port={port}');
        const entry = siteEntryFor(manifest({}), { name: 'api', repoDir: 'repos/shop', serve: { mode: 'proxy' }, devServer: { command: dev.command } });
        expect(entry).toMatchObject({ ok: true, entry: { command: ['node', 'my server.js', '--port={port}'] } });
        expect(served({ ...(entry as { entry: Record<string, unknown> }).entry }).devServer!.command).toBe(dev.command);
    });
});

describe('S5: multi-label names — Genie 1’s <site>.<workspace>.gen is served', () => {
    it('Genie 1’s default name is SERVED under its full name (it was refused as "more than one label")', () => {
        const s = served({ ...host, repo: 'shop', name: 'web', genName: 'web.acme.gen', hostServe: { mode: 'php', root: 'public' } });
        expect(s).toMatchObject({ name: 'web.acme', repoDir: 'repos/shop', serve: { mode: 'php', root: 'public' } });
        expect(served({ ...host, repo: 'shop', genName: 'API.Docs.Acme.gen', hostPort: 8085 }).name).toBe('api.docs.acme');
    });

    it('CONTROL: a one-label name is read exactly as before', () => {
        expect(served({ ...host, repo: 'shop', name: 'shop', genName: 'shop.gen', hostServe: { mode: 'php', root: 'public' } }).name).toBe('shop');
    });

    it('written back in Genie 1’s shape: `name` ONE label (Genie 1 drops any other), `genName` the full host — and it reads back as the same site', () => {
        const m = manifest({});
        const entry = siteEntryFor(m, { name: 'web.acme', repoDir: 'repos/shop', serve: { mode: 'php', root: 'public' } });
        expect(entry).toEqual({ ok: true, entry: { repo: 'shop', runMode: 'host', kind: 'http', enabled: true, name: 'web', genName: 'web.acme.gen', hostServe: { mode: 'php', root: 'public' } } });
        expect(readEnvelopeSites(withSiteEntry(m, 'k', (entry as { entry: Record<string, unknown> }).entry))[0]).toMatchObject({ ok: true, name: 'web.acme' });
    });
});

describe('an EDITED entry', () => {
    it('replaces the way it is served whole, keeps every other field — Genie 1’s own included — in place, and never re-enables it', () => {
        const before = { repo: 'shop', runMode: 'host', kind: 'http', enabled: false, name: 'shop', genName: 'shop.gen', framework: 'laravel', upstreamHost: 'shop.test', command: ['php', 'artisan', 'serve'], hostPort: 9000 };
        const next = (siteEntryFor(manifest({}), { name: 'web.acme', repoDir: 'repos/shop', serve: { mode: 'static', root: 'dist', spa: true } }) as { entry: Record<string, unknown> }).entry;
        const edited = editedSiteEntry(before, next);
        expect(edited).toEqual({ repo: 'shop', runMode: 'host', kind: 'http', enabled: false, name: 'web', genName: 'web.acme.gen', framework: 'laravel', upstreamHost: 'shop.test', hostServe: { mode: 'static', root: 'dist', spa: true } });
        // Counted: the two stale ways of serving are gone, the two Genie 1 fields stay.
        expect(['command', 'hostPort'].filter((k) => k in edited)).toEqual([]);
        expect(['framework', 'upstreamHost'].filter((k) => k in edited)).toHaveLength(2);
        expect(Object.keys(edited).slice(0, 6)).toEqual(['repo', 'runMode', 'kind', 'enabled', 'name', 'genName']);
    });
});

describe('what Genie 2 cannot serve is listed with the reason, never dropped', () => {
    it.each([
        ['a container site', { ...host, runMode: 'explicit', repo: 'shop', genName: 'wallet.gen', command: ['node', 's.js'] }, /workspace container/],
        ['a production recipe', { ...host, runMode: 'recipe', repo: 'shop', genName: 'r.gen' }, /runMode "recipe"/],
        ['a name with an invalid label', { ...host, repo: 'shop', genName: 'web_1.acme.gen', hostServe: { mode: 'php', root: 'public' } }, /"web_1" is not a hostname label/],
        ['a name with an empty label', { ...host, repo: 'shop', genName: 'web..acme.gen', hostServe: { mode: 'php', root: 'public' } }, /empty label/],
        ['octane', { ...host, repo: 'shop', genName: 'o.gen', hostServe: { mode: 'octane', server: 'swoole' } }, /"octane" is not one Genie 2 serves/],
        ['frankenphp', { ...host, repo: 'shop', genName: 'f.gen', hostServe: { mode: 'frankenphp', root: 'public' } }, /"frankenphp"/],
        // A PIN is served now (T4) — only a pin that is not a version is refused; see "a php site’s PHP pin" above.
        ['a PHP pin that is not a version', { ...host, repo: 'shop', genName: 'p.gen', hostServe: { mode: 'php', root: 'public', version: 'latest' } }, /hostServe\.version "latest" is not a PHP version/],
        ['a tcp site', { ...host, kind: 'tcp', repo: 'shop', genName: 't.gen', hostPort: 5432 }, /tcp site/],
        ['nothing to serve', { ...host, repo: 'shop', genName: 'n.gen' }, /no way to serve/],
        ['a repo outside', { ...host, repo: '../x', genName: 'o.gen', hostPort: 1 }, /not a folder name/],
    ])('%s', (_label, entry, reason) => {
        const s = refused(entry);
        expect(s.reason).toMatch(reason);
        expect(s.host).toBe(String(entry.genName));
    });

    it('a non-object entry is still a row', () => {
        expect(readEnvelopeSites(manifest({ bad: 'nope' }))).toEqual([{ key: 'bad', ok: false, name: 'bad', enabled: false, host: 'bad.gen', repoDir: null, reason: 'its entry is not an object' }]);
    });

    it('every entry comes back, in the file’s order — count in = count out', () => {
        const sites = { a: { ...host, repo: 'shop', genName: 'a.gen', hostPort: 1 }, b: { ...host, runMode: 'explicit', genName: 'b.gen' }, c: 7 };
        expect(readEnvelopeSites(manifest(sites)).map((s) => [s.key, s.ok])).toEqual([['a', true], ['b', false], ['c', false]]);
        expect(readEnvelopeSites({ name: 'no sites' })).toEqual([]);
        expect(readEnvelopeSites(null)).toEqual([]);
    });
});

describe('writing a site back', () => {
    it('the key is Genie 1’s: sha256(workspace \\0 lower-cased name), 16 hex', () => {
        expect(siteKeyFor('acme', 'Shop')).toBe('015283ee3ad87156');
    });

    it('an entry in Genie 1’s shape for each mode, naming the repo Genie 1 resolves; a folder that is not a repo is refused', () => {
        const m = manifest({});
        expect(siteEntryFor(m, { name: 'docs', repoDir: 'repos/docs-site', serve: { mode: 'static', root: 'build', spa: true } })).toEqual({ ok: true, entry: { repo: 'docs-site', runMode: 'host', kind: 'http', enabled: true, name: 'docs', genName: 'docs.gen', hostServe: { mode: 'static', root: 'build', spa: true } } });
        expect(siteEntryFor(m, { name: 'shop', repoDir: 'repos/shop', serve: { mode: 'php', root: 'public' } })).toMatchObject({ ok: true, entry: { repo: 'shop', hostServe: { mode: 'php', root: 'public' } } });
        expect(siteEntryFor(m, { name: 'deep', repoDir: 'apps/deep', serve: { mode: 'proxy' }, hostPort: 9 })).toMatchObject({ ok: true, entry: { repo: 'deep', hostPort: 9 } });
        expect(siteEntryFor(m, { name: 'root', repoDir: '.', serve: { mode: 'proxy' }, hostPort: 9 })).toMatchObject({ ok: true, entry: { repo: '' } });
        expect(siteEntryFor(m, { name: 'new', repoDir: 'repos/new', serve: { mode: 'proxy' }, hostPort: 9 })).toMatchObject({ ok: true, entry: { repo: 'new' } });
        expect(siteEntryFor(m, { name: 'odd', repoDir: 'tools/odd', serve: { mode: 'proxy' }, hostPort: 9 })).toMatchObject({ ok: false });
        // What is written reads back as the same site.
        const back = readEnvelopeSites(withSiteEntry(m, 'k', (siteEntryFor(m, { name: 'docs', repoDir: 'repos/docs-site', serve: { mode: 'static', root: 'build', spa: true } }) as { entry: Record<string, unknown> }).entry))[0];
        expect(back).toMatchObject({ ok: true, name: 'docs', repoDir: 'repos/docs-site', serve: { mode: 'static', root: 'build', spa: true } });
    });

    it('edits ONE key: every other key — and its position — is carried through untouched', () => {
        const m = { $schema: 's', name: 'Acme', tynnToken: 'tok-example', repos: [{ name: 'a', slug: 'a', path: 'repos/a' }], sites: { old: { genName: 'old.gen' } }, hosting: { enabled: true }, tynn: { project: 'p' } };
        const added = withSiteEntry(m, 'new1', { genName: 'n.gen' });
        expect(Object.keys(added)).toEqual(Object.keys(m));
        expect(added.sites).toEqual({ old: { genName: 'old.gen' }, new1: { genName: 'n.gen' } });
        for (const k of Object.keys(m).filter((k) => k !== 'sites')) expect(added[k]).toBe((m as Record<string, unknown>)[k]);
        expect(withSiteEntry(added, 'old', null).sites).toEqual({ new1: { genName: 'n.gen' } });
        // A manifest with no sites block gets one at the end; the input is never mutated.
        const bare = { name: 'B', repos: [] };
        expect(Object.keys(withSiteEntry(bare, 'x', {}))).toEqual(['name', 'repos', 'sites']);
        expect(bare).toEqual({ name: 'B', repos: [] });
        expect(m.sites).toEqual({ old: { genName: 'old.gen' } });
    });

    it('writes in the original file’s style: its indentation, its line endings, its final newline', () => {
        const v = { a: 1, b: [2] };
        expect(formatLike('{\n  "a": 0\n}\n', v)).toBe('{\n  "a": 1,\n  "b": [\n    2\n  ]\n}\n');
        expect(formatLike('{\r\n    "a": 0\r\n}\r\n', v)).toBe('{\r\n    "a": 1,\r\n    "b": [\r\n        2\r\n    ]\r\n}\r\n');
        expect(formatLike('{\n\t"a": 0\n}', v)).toBe('{\n\t"a": 1,\n\t"b": [\n\t\t2\n\t]\n}');
        // A string value holding an escaped newline stays escaped (only real line breaks follow the file).
        expect(formatLike('{\r\n  "a": 0\r\n}\r\n', { s: 'x\ny' })).toBe('{\r\n  "s": "x\\ny"\r\n}\r\n');
    });
});
