import { describe, expect, it } from 'vitest';
import { phpIniContents } from '../src/core/php-versions.js';
import { serveCaddyfile } from '../src/core/serve-config.js';
import { ProcessSupervisor } from '../src/main/process-supervisor.js';
import { refreshManagedIni } from '../src/main/php-versions.js';
import * as siteManager from '../src/main/site-manager.js';

/**
 * PHP SITES ARE FAST AND CONCURRENT (genie#1043; moic, 2026-10-21, measured on moic.gen through the front door: a static
 * file 5 ms, Laravel /up 2,606 ms, 4 parallel fetches 3,267 ms served one after another, a cold reload's ~35 API calls
 * ~1.1 s apart — "the feature doesn't work at all"). Two causes: opcache off in Genie's php.ini (every request recompiles
 * Laravel), and ONE php-cgi worker (php-cgi ignores PHP_FCGI_CHILDREN on Windows). Now: opcache on, with its file cache
 * in a directory Genie makes (what lets php-cgi start on Windows) and timestamps checked on every request (an edited
 * file shows at once — these are sites being developed); and several workers, the site's Caddy sending each request to
 * the least busy one.
 */

describe('the managed php.ini', () => {
    const ini = phpIniContents('C:\\genie\\php\\8.4.26');
    it('loads opcache and turns it on for php-cgi', () => {
        expect(ini).toMatch(/^zend_extension=opcache$/m);
        expect(ini).toMatch(/^opcache\.enable=1$/m);
    });
    it('caches compiled files in the version’s own opcache directory, falling back to it when shared memory cannot attach', () => {
        expect(ini).toContain('opcache.file_cache="C:\\genie\\php\\8.4.26\\opcache"');
        expect(ini).toMatch(/^opcache\.file_cache_fallback=1$/m);
    });
    it('an edited file shows on the next request: timestamps checked every time', () => {
        expect(ini).toMatch(/^opcache\.validate_timestamps=1$/m);
        expect(ini).toMatch(/^opcache\.revalidate_freq=0$/m);
    });
});

describe('the site’s Caddy and its PHP workers', () => {
    const php = serveCaddyfile({ sitePort: 4101, repoPath: '/repo', serve: { mode: 'php', root: 'public', fcgiPort: 4102, fcgiPorts: [4102, 4103, 4104, 4105] } })!;
    it('php_fastcgi names every worker (COUNTED: four)', () => {
        expect(php).toContain('php_fastcgi 127.0.0.1:4102 127.0.0.1:4103 127.0.0.1:4104 127.0.0.1:4105 {');
    });
    it('each request goes to the least busy worker, and the retry while one restarts is kept', () => {
        const block = /php_fastcgi [^{]*\{([\s\S]*?)\n\t\}/.exec(php)?.[1] ?? '';
        expect(block).toMatch(/\n\t\tlb_policy least_conn/);
        expect(block).toMatch(/lb_try_duration/);
    });
    it('CONTROL: one worker reads exactly as before', () => {
        const one = serveCaddyfile({ sitePort: 4101, repoPath: '/repo', serve: { mode: 'php', root: 'public', fcgiPort: 4102 } })!;
        expect(one).toContain('php_fastcgi 127.0.0.1:4102 {');
    });
});

describe('a PHP site starts several workers', () => {
    const PHP_WORKERS = (siteManager as { PHP_WORKERS?: number }).PHP_WORKERS;
    const { SiteManager } = siteManager;
    function make(over: Record<string, unknown> = {}) {
        const opened: string[] = [];
        const pty = {
            open: (o: { command?: string }) => { opened.push(o.command ?? ''); return { id: `t_${opened.length}`, pid: opened.length, shell: 'sh', scrollback: '' }; },
            write: () => true, resize: () => true, kill: () => true, scrollback: () => '', onData: () => () => {}, onExit: () => () => {},
        };
        const supervisor = new ProcessSupervisor(pty as never, { now: () => 0, schedule: () => () => {} });
        let port = 4100;
        const configs: string[] = [];
        const sites = new SiteManager({ supervisor, allocatePort: () => ++port, caddyBin: '/opt/caddy', configDir: '/cfg', writeConfig: (_p: string, text: string) => { configs.push(text); }, ...over } as never);
        return { supervisor, sites, opened, configs };
    }

    it('four by default, each php-cgi on its own port, all named in the site’s Caddyfile (COUNTED)', () => {
        expect(PHP_WORKERS).toBe(4);
        const { supervisor, sites, opened, configs } = make();
        sites.create({ name: 'shop', workspaceId: 'acme', repoPath: '/w/acme/repos/shop', serve: { mode: 'php', root: 'public' } });
        expect(supervisor.list().map((p) => p.id).sort()).toEqual(['site_shop', 'site_shop-fcgi', 'site_shop-fcgi-2', 'site_shop-fcgi-3', 'site_shop-fcgi-4']);
        const ports = opened.filter((c) => / -b 127\.0\.0\.1:\d+$/.test(c)).map((c) => Number(/:(\d+)$/.exec(c)![1]));
        expect(ports).toHaveLength(4);
        expect(new Set(ports).size).toBe(4);
        expect(configs.at(-1)).toContain(`php_fastcgi ${ports.map((p) => `127.0.0.1:${p}`).join(' ')} {`);
    });

    it('an env change restarts EVERY worker, each on its own port again (COUNTED: four more starts)', () => {
        let env: Record<string, string> = { DB_PORT: '1' };
        const { sites, opened } = make({ serviceEnv: () => env });
        sites.create({ name: 'shop', workspaceId: 'acme', repoPath: '/w/acme/repos/shop', serve: { mode: 'php', root: 'public' } });
        const workers = () => opened.filter((c) => / -b 127\.0\.0\.1:\d+$/.test(c));
        const before = workers().map((c) => /:(\d+)$/.exec(c)![1]);
        env = { DB_PORT: '2' };
        sites.serviceEnvChanged('acme');
        const after = workers().slice(4).map((c) => /:(\d+)$/.exec(c)![1]);
        expect(after).toEqual(before);
    });

    it('a real start prepares the pinned PHP; asking which php-cgi a pin would run does not (a lookup writes nothing)', () => {
        const prepared: Array<string | undefined> = [];
        const { sites } = make({ resolvePhpCgi: () => ({ ok: true, command: 'C:\\php\\php-cgi.exe' }), preparePhpCgi: (pin: string | undefined) => prepared.push(pin) });
        expect(sites.phpCgiFor('8.4').ok).toBe(true);
        expect(prepared).toEqual([]);
        sites.create({ name: 'shop', workspaceId: 'acme', repoPath: '/w/acme/repos/shop', serve: { mode: 'php', root: 'public', version: '8.4' } });
        expect(prepared).toEqual(['8.4']);
    });

    it('a site removed forgets every worker', () => {
        const { supervisor, sites } = make();
        sites.create({ name: 'shop', workspaceId: 'acme', repoPath: '/w/acme/repos/shop', serve: { mode: 'php', root: 'public' } });
        expect(sites.remove('site_shop')).toBe(true);
        expect(supervisor.list()).toEqual([]);
    });
});

describe('a version installed before opcache', () => {
    it('gets the current ini and its cache directory when a pinned site starts; an unpinned site writes nothing', () => {
        const written: string[] = [];
        const made: string[] = [];
        const fs = {
            exists: (p: string) => /php-cgi\.exe$/.test(p),
            list: (d: string) => (d === 'C:/php' ? ['8.4.26'] : []),
            mkdirp: (d: string) => { made.push(d); },
            writeText: (p: string, t: string) => { written.push(`${p}::${/zend_extension=opcache/.test(t)}`); },
            writeBytes: () => {}, rename: () => {}, removeTree: () => {},
        };
        refreshManagedIni(undefined, { platform: 'win32', root: 'C:/php', fs });
        expect(written).toEqual([]);
        refreshManagedIni('8.4', { platform: 'win32', root: 'C:/php', fs });
        expect(written).toHaveLength(1);
        expect(written[0]).toMatch(/php\.ini::true$/);
        expect(made).toHaveLength(1);
        expect(made[0]).toMatch(/opcache$/);
    });
});
