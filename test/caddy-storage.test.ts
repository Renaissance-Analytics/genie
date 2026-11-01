import { describe, expect, it } from 'vitest';
import { FRONT_DOOR_STORAGE_CLEAN_INTERVAL, frontDoorCaddyfile } from '../src/core/front-door-caddy.js';
import { serveCaddyfile } from '../src/core/serve-config.js';
import { ProcessSupervisor } from '../src/main/process-supervisor.js';
import { SiteManager } from '../src/main/site-manager.js';
import type { PtyPort } from '../src/main/terminal-host.js';

/**
 * EVERY GENIE CADDY KEEPS ITS OWN STORAGE (the owner's Defender recording, 2026-10-31: Genie's Caddy touched
 * `%AppData%\Caddy\locks\storage_clean.lock` 72 times in 120 s — the top file Defender scanned).
 *
 * Caddy cleans its storage when a process STARTS ("Storage will always be cleaned when the process first starts",
 * Caddy's global options docs), under a file lock named `storage_clean` in that storage. Each site's Caddy named no
 * storage, so all of them used the default one — `%AppData%\Caddy` on Windows — and they all start together at boot.
 * On Windows they collided on that one lock file (a site's log, 16:23:28: "unable to acquire storage_clean lock: …
 * The process cannot access the file because it is being used by another process"), and the lock was left behind,
 * kept fresh by its holder every 5 s (certmagic's lockFreshnessInterval) for as long as Genie ran.
 *
 * A site's Caddy has nothing in storage to clean: `auto_https off` and no `tls` — it serves plain HTTP behind the front
 * door, which holds Genie's certificate. So each one names its OWN storage under Genie's runtime dir and does not clean
 * it at all (`storage_clean_interval off` = tls app `disable_storage_clean`, httpcaddyfile/tlsapp.go), and keeps no
 * autosave (`persist_config off`: Genie 1's per-site Caddyfile had it, main/dev-server/serve-config.ts at
 * v0.7.0-beta.342, "stops every per-site Caddy racing to overwrite one shared autosave.json").
 */

const globalsOf = (caddyfile: string) => /^\{([\s\S]*?)\n\}/.exec(caddyfile)?.[1] ?? '';

describe('a site’s Caddyfile names its own storage and never cleans it', () => {
    for (const serve of [{ mode: 'static', root: 'dist', spa: false }, { mode: 'php', root: 'public', fcgiPort: 4102 }] as const) {
        it(`${serve.mode}: storage file_system <its own dir>, storage_clean_interval off, persist_config off — in the global block`, () => {
            const out = serveCaddyfile({ sitePort: 4101, repoPath: '/repo', serve, storageDir: '/home/me/.genie/runtime/sites/site_docs/caddy-data' })!;
            const globals = globalsOf(out);
            // COUNTED: one of each, in the global options (a site block would not accept them).
            expect(globals.match(/^\tstorage file_system "\/home\/me\/\.genie\/runtime\/sites\/site_docs\/caddy-data"$/gm) ?? []).toHaveLength(1);
            expect(globals.match(/^\tstorage_clean_interval off$/gm) ?? []).toHaveLength(1);
            expect(globals.match(/^\tpersist_config off$/gm) ?? []).toHaveLength(1);
            expect(out.match(/storage/g) ?? []).toHaveLength(2);
        });
    }

    it('a Windows storage path is written with forward slashes and quoted; one that could break the quote is refused', () => {
        const out = serveCaddyfile({ sitePort: 4101, repoPath: 'C:/repo', serve: { mode: 'static', root: 'dist', spa: false }, storageDir: 'C:\\Users\\Jo Example\\.genie\\runtime\\sites\\site_docs\\caddy-data' })!;
        expect(globalsOf(out)).toContain('\tstorage file_system "C:/Users/Jo Example/.genie/runtime/sites/site_docs/caddy-data"');
        expect(() => serveCaddyfile({ sitePort: 4101, repoPath: '/repo', serve: { mode: 'static', root: 'dist', spa: false }, storageDir: '/tmp/x" {\n}' })).toThrow(/cannot be written into a Caddyfile/);
    });

    it('a static or php site without a storage dir is refused — never left on Caddy’s shared default', () => {
        expect(() => serveCaddyfile({ sitePort: 4101, repoPath: '/repo', serve: { mode: 'static', root: 'dist', spa: false } })).toThrow(/storage/);
        expect(() => serveCaddyfile({ sitePort: 4101, repoPath: '/repo', serve: { mode: 'php', root: 'public', fcgiPort: 4102 } })).toThrow(/storage/);
        // CONTROL: proxy mode renders nothing, and needs nothing.
        expect(serveCaddyfile({ sitePort: 4101, serve: { mode: 'proxy' } })).toBeNull();
    });
});

describe('the site manager gives every site’s Caddy a storage dir of its own', () => {
    function make() {
        const port: PtyPort = {
            open: (o) => ({ id: `t_${o.command?.length ?? 0}_${Math.random()}`, pid: 1, shell: 'sh', scrollback: '' }),
            write: () => true, resize: () => true, kill: () => true, scrollback: () => '',
            onData: () => () => {}, onExit: () => () => {},
        };
        const supervisor = new ProcessSupervisor(port, { now: () => 0, schedule: () => () => {} });
        const written: Array<{ path: string; content: string }> = [];
        let next = 4100;
        const sites = new SiteManager({ supervisor, allocatePort: () => ++next, caddyBin: '/opt/genie/runtime/caddy', configDir: '/data/sites', writeConfig: (path, content) => { written.push({ path, content }); }, phpWorkers: 1 });
        return { sites, written };
    }

    it('two sites → two Caddyfiles, each naming <configDir>/<site id>/caddy-data — never the same storage', () => {
        const { sites, written } = make();
        sites.create({ name: 'docs', workspaceId: 'w', repoPath: '/repos/docs', serve: { mode: 'static', root: 'dist', spa: false } });
        sites.create({ name: 'shop', workspaceId: 'w', repoPath: '/repos/shop', serve: { mode: 'php', root: 'public' } });
        const storage = written.map((w) => /^\tstorage file_system "([^"]+)"$/m.exec(w.content)?.[1]);
        expect(storage).toHaveLength(2);
        expect(storage[0]).toMatch(/^\/data\/sites\/site_docs\/caddy-data$/);
        expect(storage[1]).toMatch(/^\/data\/sites\/site_shop\/caddy-data$/);
        expect(new Set(storage).size).toBe(2);
    });
});

describe('the front door’s Caddyfile names its storage and a clean interval', () => {
    const routes = [{ host: 'tynn.gen', target: '127.0.0.1:4101' }];
    const tls = { certPath: '/home/me/.genie/runtime/gen-ca/leaf.crt', keyPath: '/home/me/.genie/runtime/gen-ca/leaf.key' };
    const storageDir = '/home/me/.genie/runtime/caddy/data/caddy';

    it('storage file_system <Genie’s caddy data dir> and storage_clean_interval <interval>, routes or none', () => {
        for (const [rs, t] of [[routes, tls], [[], null]] as const) {
            const globals = globalsOf(frontDoorCaddyfile(rs, t, storageDir));
            expect(globals.match(/^\tstorage file_system "\/home\/me\/\.genie\/runtime\/caddy\/data\/caddy"$/gm) ?? []).toHaveLength(1);
            expect(globals.match(new RegExp(`^\\tstorage_clean_interval ${FRONT_DOOR_STORAGE_CLEAN_INTERVAL}$`, 'gm')) ?? []).toHaveLength(1);
        }
        // Longer than Caddy's 24h default: the front door holds no certificate Caddy manages (it serves Genie's leaf
        // from files), so there is nothing to expire in a day.
        expect(FRONT_DOOR_STORAGE_CLEAN_INTERVAL).toBe('168h');
    });
});
