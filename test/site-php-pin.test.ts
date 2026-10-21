import { describe, expect, it } from 'vitest';
import type { PtyPort, PtySpawnOptions } from '../src/main/terminal-host.js';
import { ProcessSupervisor } from '../src/main/process-supervisor.js';
import { SiteManager, type SiteManagerDeps } from '../src/main/site-manager.js';

/**
 * T4 — A PHP SITE'S PIN AT START. A pinned site's php-cgi worker is started from that version's binary (the resolver's
 * command), still with Genie's CA ini directory; an unpinned one runs `php-cgi` from PATH as before; a pin the resolver
 * cannot honour fails the start with its reason and starts NOTHING — never a fallback to another PHP. The resolver here
 * is a fake that records what it was asked; main/php-versions.ts `resolvePhpCgi` is tested on its own.
 */

const MANAGED = '"C:\\Users\\Jo Example\\genie2-toolchain\\php-versions\\8.4.26\\php-cgi.exe" -c "C:\\Users\\Jo Example\\genie2-toolchain\\php-versions\\8.4.26\\php.ini"';

function make(over: Partial<SiteManagerDeps> = {}) {
    const opened: PtySpawnOptions[] = [];
    let n = 0;
    const pty: PtyPort = {
        open: (o) => { opened.push(o); n += 1; return { id: `term_${n}`, pid: 3000 + n, shell: o.command ?? 'sh', scrollback: '' }; },
        write: () => true, resize: () => true, kill: () => true, scrollback: () => '',
        onData: () => () => {}, onExit: () => () => {},
    };
    const asked: Array<string | undefined> = [];
    let port = 4300;
    const deps: SiteManagerDeps = {
        supervisor: new ProcessSupervisor(pty, { now: () => 0, schedule: () => () => {} }),
        allocatePort: () => ++port,
        caddyBin: '/opt/genie/runtime/caddy',
        configDir: '/data/sites',
        writeConfig: () => {},
        phpWorkerEnv: () => ({ PHP_INI_SCAN_DIR: ';C:\\genie2-toolchain\\php\\conf.d' }),
        resolvePhpCgi: (pin) => {
            asked.push(pin);
            if (pin === undefined) return { ok: true, command: 'php-cgi' };
            if (pin === '8.4' || pin === '8.4.26') return { ok: true, command: MANAGED };
            return { ok: false, reason: `this site is pinned to PHP ${pin}, which Genie does not manage on this machine` };
        },
        // One worker: these tests are about the pin; several workers are test/php-fast.test.ts's.
        phpWorkers: 1,
        ...over,
    };
    return { opened, asked, sites: new SiteManager(deps) };
}

const workers = (opened: readonly PtySpawnOptions[]) => opened.filter((o) => o.command?.includes('-b 127.0.0.1:'));

describe('a php site starts the php-cgi its pin names', () => {
    it('pinned: the worker is that managed binary with its own php.ini, and still gets Genie’s CA ini directory', () => {
        const { opened, asked, sites } = make();
        sites.create({ name: 'shop', workspaceId: 'acme', repoPath: '/repos/shop', serve: { mode: 'php', root: 'public', version: '8.4' } });
        expect(asked).toEqual(['8.4']);
        expect(workers(opened).map((o) => o.command)).toEqual([`${MANAGED} -b 127.0.0.1:4302`]);
        expect(workers(opened)[0]!.env).toEqual({ PHP_INI_SCAN_DIR: ';C:\\genie2-toolchain\\php\\conf.d', PHP_FCGI_MAX_REQUESTS: '0' });
    });

    it('control — unpinned: `php-cgi` from PATH, exactly as before', () => {
        const { opened, sites } = make();
        sites.create({ name: 'blog', workspaceId: 'acme', repoPath: '/repos/blog', serve: { mode: 'php', root: 'public' } });
        expect(workers(opened).map((o) => o.command)).toEqual(['php-cgi -b 127.0.0.1:4302']);
    });

    it('a pin Genie cannot honour fails the start with the reason, starts nothing, and keeps the reason on the site', () => {
        const { opened, sites } = make();
        const declared = sites.declare({ name: 'legacy', workspaceId: 'acme', repoPath: '/repos/legacy', serve: { mode: 'php', root: 'public', version: '7.4' } });
        expect(() => sites.start(declared.id)).toThrow(/legacy\.gen was not started: this site is pinned to PHP 7\.4, which Genie does not manage/);
        expect(opened).toEqual([]);
        expect(sites.get(declared.id)).toMatchObject({ state: 'stopped', problem: expect.stringMatching(/pinned to PHP 7\.4/) });
    });

    it('with no resolver wired, a pinned site is refused — never served on the PATH PHP; an unpinned one still runs', () => {
        const { opened, sites } = make({ resolvePhpCgi: undefined as never });
        const pinned = sites.declare({ name: 'pinned', workspaceId: 'acme', repoPath: '/repos/p', serve: { mode: 'php', root: 'public', version: '8.4' } });
        expect(() => sites.start(pinned.id)).toThrow(/pinned to PHP 8\.4/);
        expect(opened).toEqual([]);
        sites.create({ name: 'plain', workspaceId: 'acme', repoPath: '/repos/plain', serve: { mode: 'php', root: 'public' } });
        expect(workers(opened).map((o) => o.command)).toEqual(['php-cgi -b 127.0.0.1:4302']);
    });
});
