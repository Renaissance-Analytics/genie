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
        expect(pty.opened[0]).toMatchObject({ cwd: '/repos/tynn', command: 'php artisan serve --host=127.0.0.1 --port=4101', env: { DB_HOST: '127.0.0.1', DB_PORT: '54321' } });
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
        expect(written[0]!.path).toBe('/data/sites/site_dash/Caddyfile');
        expect(written[0]!.content).toContain('127.0.0.1:4101');
        expect(written[0]!.content).toContain('try_files {path} /index.html');
        expect(pty.opened[0]).toMatchObject({ cwd: '/repos/fancy', command: '/opt/genie/runtime/caddy run --config /data/sites/site_dash/Caddyfile --adapter caddyfile' });
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
            '/opt/genie/runtime/caddy run --config /data/sites/site_app/Caddyfile --adapter caddyfile',
        ]);
        for (const o of pty.opened) expect(o).toMatchObject({ cwd: '/repos/app', env: { APP_ENV: 'local' } });
        expect(written[0]!.content).toContain('php_fastcgi 127.0.0.1:4102');
        expect(written[0]!.content).toContain('root * /repos/app/public');
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
