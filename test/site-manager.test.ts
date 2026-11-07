import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { PtyOpened, PtyPort, PtySpawnOptions } from '../src/main/terminal-host.js';
import { ProcessSupervisor } from '../src/main/process-supervisor.js';
import { SiteManager, type SiteManagerDeps } from '../src/main/site-manager.js';

/**
 * HOSTED `.gen` SITES (§6.6) — the manager: a site is a NAME, a repo and a serve spec; Genie
 * allocates loopback ports, starts the right processes under the supervisor (the repo's own dev
 * server, or Genie's Caddy against a Caddyfile Genie wrote — plus a php-cgi worker for php), and
 * publishes `<name>.gen → 127.0.0.1:<port>` for the front door. Agents never write server config.
 */

// The config path is a REAL path on the platform the test runs on — backslashes on Windows — so the
// expectation is built with the same `join` the manager uses, not a Linux-shaped literal.
const CADDYFILE = (id: string) => join('/data/sites', id, 'Caddyfile');

function fakePty() {
    const opened: Array<PtySpawnOptions & { id: string }> = [];
    const killed: string[] = [];
    const exit = new Set<(id: string, code: number) => void>();
    let n = 0;
    const port: PtyPort = {
        open(options) {
            const id = `term_${++n}`;
            opened.push({ ...options, id });
            return { id, pid: 2000 + n, shell: options.command ?? 'sh', scrollback: '' } satisfies PtyOpened;
        },
        write: () => true,
        resize: () => true,
        kill: (id) => { killed.push(id); return true; },
        scrollback: () => '',
        onData: () => () => {},
        onExit: (l) => { exit.add(l); return () => exit.delete(l); },
    };
    return { port, opened, killed };
}

function make(over: Partial<SiteManagerDeps> = {}) {
    const pty = fakePty();
    const supervisor = new ProcessSupervisor(pty.port, { now: () => 0, schedule: () => () => {} });
    const written: Array<{ path: string; content: string }> = [];
    let next = 4100;
    const deps: SiteManagerDeps = {
        supervisor,
        allocatePort: () => ++next,
        caddyBin: '/opt/genie/runtime/caddy',
        configDir: '/data/sites',
        writeConfig: (path, content) => { written.push({ path, content }); },
        // One PHP worker: these tests are about the lifecycle; several workers are test/php-fast.test.ts's.
        phpWorkers: 1,
        ...over,
    };
    return { pty, supervisor, written, sites: new SiteManager(deps) };
}

describe('a proxy site — the repo’s own dev server', () => {
    it('allocates a port, substitutes it into the command, runs it in the repo with the service env, and publishes the route', () => {
        const { pty, sites } = make();
        const site = sites.create({
            name: 'tynn',
            workspaceId: 'tynn',
            repoPath: '/repos/tynn',
            serve: { mode: 'proxy' },
            devServer: { stack: 'laravel', command: 'php artisan serve --host=127.0.0.1 --port={port}' },
            env: { DB_HOST: '127.0.0.1', DB_PORT: '54321' },
        });
        expect(site).toMatchObject({ id: 'site_tynn', host: 'tynn.gen', port: 4101, state: 'running' });
        expect(pty.opened).toHaveLength(1);
        expect(pty.opened[0]).toMatchObject({ cwd: '/repos/tynn', command: 'php -d variables_order=GPCS artisan serve --host=127.0.0.1 --port=4101', env: { DB_HOST: '127.0.0.1', DB_PORT: '54321' } });
        expect(sites.routes()).toEqual([{ host: 'tynn.gen', target: '127.0.0.1:4101' }]);
    });

    it('a site pointed at a port you already run starts NO process and still publishes the route', () => {
        const { pty, sites } = make();
        const site = sites.create({ name: 'docs', workspaceId: 'tynn', repoPath: '/repos/tynn', serve: { mode: 'proxy' }, hostPort: 5173 });
        expect(pty.opened).toHaveLength(0);
        expect(site).toMatchObject({ port: 5173, state: 'external' });
        expect(sites.routes()).toEqual([{ host: 'docs.gen', target: '127.0.0.1:5173' }]);
    });

    it('a proxy site with neither a dev server nor a port is refused with the reason', () => {
        const { sites } = make();
        expect(() => sites.create({ name: 'x', workspaceId: 'tynn', repoPath: '/r', serve: { mode: 'proxy' } })).toThrow(/dev server|hostPort/);
    });
});

describe('a static site — Genie’s Caddy against a Caddyfile Genie wrote', () => {
    it('writes the per-site Caddyfile under the config dir and runs the bundled Caddy against it', () => {
        const { pty, written, sites } = make();
        const site = sites.create({ name: 'dash', workspaceId: 'fancy', repoPath: '/repos/fancy', serve: { mode: 'static', root: 'dist', spa: true } });
        expect(site).toMatchObject({ host: 'dash.gen', port: 4101, state: 'running' });
        expect(written).toHaveLength(1);
        expect(written[0]!.path).toBe(CADDYFILE('site_dash'));
        // Its port, any Host (the front door forwards the site's own name), bound to loopback (serve-config.ts).
        expect(written[0]!.content).toContain('http://:4101 {');
        expect(written[0]!.content).toContain('bind 127.0.0.1');
        expect(written[0]!.content).toContain('try_files {path} /index.html');
        expect(pty.opened[0]).toMatchObject({ cwd: '/repos/fancy', command: `/opt/genie/runtime/caddy run --config ${CADDYFILE('site_dash')} --adapter caddyfile` });
    });

    it('with no Caddy binary available, the site is refused with a reason that names the fix — never a hand-rolled server', () => {
        const { pty, sites } = make({ caddyBin: null });
        expect(() => sites.create({ name: 'dash', workspaceId: 'fancy', repoPath: '/repos/fancy', serve: { mode: 'static', root: 'dist', spa: true } })).toThrow(/Caddy/);
        expect(pty.opened).toHaveLength(0);
    });
});

describe('a php site — a FastCGI worker, then Caddy', () => {
    it('allocates TWO ports, starts php-cgi first and Caddy second, both in the repo with the service env', () => {
        const { pty, written, sites } = make();
        const site = sites.create({ name: 'app', workspaceId: 'tynn', repoPath: '/repos/app', serve: { mode: 'php', root: 'public' }, env: { APP_ENV: 'local' } });
        expect(site).toMatchObject({ port: 4101, state: 'running' });
        expect(pty.opened.map((o) => o.command)).toEqual([
            'php-cgi -b 127.0.0.1:4102',
            `/opt/genie/runtime/caddy run --config ${CADDYFILE('site_app')} --adapter caddyfile`,
        ]);
        for (const o of pty.opened) expect(o).toMatchObject({ cwd: '/repos/app', env: { APP_ENV: 'local' } });
        expect(written[0]!.content).toContain('php_fastcgi 127.0.0.1:4102');
        expect(written[0]!.content).toContain('root * /repos/app/public');
    });

    it('the php-cgi worker — and only it — is given Genie’s CA ini directory, read at each start; the site’s own env wins', () => {
        let scan: Record<string, string> = {};
        const { pty, sites } = make({ phpWorkerEnv: () => scan });
        // Control: before any repair there is nothing to add, and the worker gets exactly the site's env — plus the
        // no-request-limit every PHP worker runs with (PHP_WORKER_ENV, php-worker-durable.test.ts).
        sites.create({ name: 'app', workspaceId: 'tynn', repoPath: '/repos/app', serve: { mode: 'php', root: 'public' }, env: { APP_ENV: 'local' } });
        expect(pty.opened[0]!.env).toEqual({ APP_ENV: 'local', PHP_FCGI_MAX_REQUESTS: '0' });
        // After a repair, the NEXT start carries it (no relaunch), on the worker and not on Caddy.
        scan = { PHP_INI_SCAN_DIR: ':/data/genie2-toolchain/php/conf.d' };
        sites.stop('site_app');
        sites.start('site_app');
        const fcgi = pty.opened.filter((o) => o.command?.startsWith('php-cgi'));
        expect(fcgi).toHaveLength(2);
        expect(fcgi[1]!.env).toEqual({ PHP_INI_SCAN_DIR: ':/data/genie2-toolchain/php/conf.d', APP_ENV: 'local', PHP_FCGI_MAX_REQUESTS: '0' });
        const caddy = pty.opened.filter((o) => o.command?.includes('caddy'));
        expect(caddy[1]!.env).toEqual({ APP_ENV: 'local' });
        // The site's own env wins over Genie's.
        const own = make({ phpWorkerEnv: () => ({ PHP_INI_SCAN_DIR: '/genie' }) });
        own.sites.create({ name: 'mine', workspaceId: 'tynn', repoPath: '/repos/mine', serve: { mode: 'php', root: 'public' }, env: { PHP_INI_SCAN_DIR: '/mine' } });
        expect(own.pty.opened[0]!.env).toEqual({ PHP_INI_SCAN_DIR: '/mine', PHP_FCGI_MAX_REQUESTS: '0' });
    });
});

describe('lifecycle', () => {
    it('stop tears down every process of the site and withdraws the route; the site stays known as stopped', () => {
        const { pty, sites } = make();
        sites.create({ name: 'app', workspaceId: 'tynn', repoPath: '/repos/app', serve: { mode: 'php', root: 'public' } });
        expect(sites.stop('site_app')).toBe(true);
        // COUNTED: both ptys killed, not just the one the route pointed at.
        expect(pty.killed).toHaveLength(2);
        expect(sites.routes()).toEqual([]);
        expect(sites.get('site_app')).toMatchObject({ state: 'stopped' });
        expect(sites.list('tynn').map((s) => s.id)).toEqual(['site_app']);
    });

    it('remove stops and forgets; two sites cannot share a name', () => {
        const { sites } = make();
        sites.create({ name: 'app', workspaceId: 'tynn', repoPath: '/repos/app', serve: { mode: 'proxy' }, hostPort: 3000 });
        expect(() => sites.create({ name: 'App', workspaceId: 'fancy', repoPath: '/repos/other', serve: { mode: 'proxy' }, hostPort: 3001 })).toThrow(/app\.gen/);
        expect(sites.remove('site_app')).toBe(true);
        expect(sites.get('site_app')).toBeNull();
        expect(sites.remove('site_app')).toBe(false);
    });

    it('the site’s state follows its main process: a dead dev server shows the site as not running', () => {
        const { sites, supervisor } = make();
        sites.create({ name: 'tynn', workspaceId: 'tynn', repoPath: '/repos/tynn', serve: { mode: 'proxy' }, devServer: { stack: 'node', command: 'npm run dev -- --port {port}' } });
        // Simulate the supervisor seeing the process fail for good.
        supervisor.stop('site_tynn');
        expect(sites.get('site_tynn')).toMatchObject({ state: 'stopped' });
    });
});

describe('change events', () => {
    it('fires onChange on create, stop and remove — the external front door re-renders its Caddyfile from it', () => {
        const { sites } = make();
        const seen: string[] = [];
        sites.onChange(() => seen.push(sites.routes().map((r) => r.host).join(',')));
        sites.create({ name: 'docs', workspaceId: 'tynn', repoPath: '/r', serve: { mode: 'proxy' }, hostPort: 5173 });
        sites.stop('site_docs');
        sites.remove('site_docs');
        expect(seen).toEqual(['docs.gen', '', '']);
    });
});

describe('declared sites — known before, or without, a start (§6.6: a workspace’s envelope declares them)', () => {
    it('declare lists a site as stopped with no port and starts nothing; start serves it; a second start of a running site does nothing', () => {
        const { pty, sites } = make();
        const info = sites.declare({ name: 'docs', workspaceId: 'acme', repoPath: '/repos/docs', serve: { mode: 'static', root: 'dist', spa: true } });
        expect(info).toMatchObject({ id: 'site_docs', host: 'docs.gen', state: 'stopped', port: null, processIds: [], problem: null });
        expect(pty.opened).toHaveLength(0);
        expect(sites.routes()).toEqual([]);
        expect(sites.start('site_docs')).toMatchObject({ state: 'running', port: 4101, processIds: ['site_docs'] });
        expect(pty.opened).toHaveLength(1);
        expect(sites.routes()).toEqual([{ host: 'docs.gen', target: '127.0.0.1:4101' }]);
        sites.start('site_docs');
        expect(pty.opened).toHaveLength(1);
        // Stop, then start again: a stopped site comes back.
        sites.stop('site_docs');
        expect(sites.start('site_docs').state).toBe('running');
        expect(pty.opened).toHaveLength(2);
    });

    it('a declared name is taken: create and declare refuse a second site at it', () => {
        const { sites } = make();
        sites.declare({ name: 'docs', workspaceId: 'acme', repoPath: '/r', serve: { mode: 'proxy' }, hostPort: 1 });
        expect(() => sites.create({ name: 'docs', workspaceId: 'other', repoPath: '/r2', serve: { mode: 'proxy' }, hostPort: 2 })).toThrow(/docs\.gen is already a site/);
        expect(() => sites.declare({ name: 'docs', workspaceId: 'other', repoPath: '/r2', serve: { mode: 'proxy' }, hostPort: 2 })).toThrow(/docs\.gen is already a site/);
    });

    it('a refused start throws the reason, keeps it on the site as its problem, and starts nothing', () => {
        const { pty, sites } = make({ caddyBin: null });
        sites.declare({ name: 'shop', workspaceId: 'acme', repoPath: '/repos/shop', serve: { mode: 'php', root: 'public' } });
        expect(() => sites.start('site_shop')).toThrow(/bundled Caddy/);
        expect(sites.get('site_shop')).toMatchObject({ state: 'stopped', problem: expect.stringMatching(/bundled Caddy/) });
        expect(pty.opened).toHaveLength(0);
        expect(() => sites.start('site_nope')).toThrow(/no site site_nope/);
    });

    it('a php root that escapes the repo is refused before the php worker starts', () => {
        const { pty, sites } = make();
        sites.declare({ name: 'shop', workspaceId: 'acme', repoPath: '/repos/shop', serve: { mode: 'php', root: '../../etc' } });
        expect(() => sites.start('site_shop')).toThrow(/escapes the repo/);
        expect(pty.opened).toHaveLength(0);
    });

    it('an unservable declaration is listed with its reason — never started, never routed, removable', () => {
        const { pty, sites } = make();
        const info = sites.declareUnservable({ workspaceId: 'acme', name: 'wallet', host: 'wallet.gen', repoPath: '/repos/api', reason: 'it runs inside the workspace container', key: 'aaaa000000000005' });
        expect(info).toMatchObject({ id: 'site_acme_aaaa000000000005', host: 'wallet.gen', workspaceId: 'acme', state: 'unservable', serve: null, port: null, problem: 'it runs inside the workspace container' });
        expect(sites.list('acme')).toHaveLength(1);
        expect(() => sites.start(info.id)).toThrow(/cannot be served/);
        expect(pty.opened).toHaveLength(0);
        expect(sites.routes()).toEqual([]);
        expect(sites.remove(info.id)).toBe(true);
        expect(sites.list()).toEqual([]);
    });

    it('`{port}` in a dev server’s env is the allocated port — a dev server that reads PORT is told it', () => {
        const { pty, sites } = make();
        sites.create({ name: 'api', workspaceId: 'acme', repoPath: '/repos/api', serve: { mode: 'proxy' }, devServer: { stack: 'node', command: 'python dev.py' }, env: { PORT: '{port}', DB_PORT: '5432' } });
        expect(pty.opened[0]).toMatchObject({ command: 'python dev.py', env: { PORT: '4101', DB_PORT: '5432' } });
    });
});
