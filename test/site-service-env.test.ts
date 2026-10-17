import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { PtyOpened, PtyPort, PtySpawnOptions } from '../src/main/terminal-host.js';
import { ProcessSupervisor } from '../src/main/process-supervisor.js';
import { SiteManager, type SiteManagerDeps } from '../src/main/site-manager.js';

/**
 * A SITE'S SERVICE ENV IS THE WORKSPACE'S ENV NOW, never the env it was declared with (moic's acceptance, 2026-10-15):
 * a site declared before its database engine existed kept the env of that moment, so `sites restart` gave its php-cgi
 * no DB_PORT while `.env` and `services env` had one. Worse, a variable in the process env WINS over Laravel's `.env`,
 * so a site still running with an old DB_PORT ignores the right `.env` Genie wrote after an engine change.
 *
 * So: every start reads the workspace's service env (`serviceEnv`), the site's own env (its declared port variables)
 * on top; and when the workspace's service env changes (`serviceEnvChanged`), its RUNNING sites whose env differs are
 * restarted by Genie — config is always hot-swappable (the owner, 2026-10-15), never "restart to apply".
 */

function fakePty() {
    const opened: Array<PtySpawnOptions & { id: string }> = [];
    let n = 0;
    const port: PtyPort = {
        open(options) {
            const id = `term_${++n}`;
            opened.push({ ...options, id });
            return { id, pid: 3000 + n, shell: options.command ?? 'sh', scrollback: '' } satisfies PtyOpened;
        },
        write: () => true,
        resize: () => true,
        kill: () => true,
        scrollback: () => '',
        onData: () => () => {},
        onExit: () => () => {},
    };
    return { port, opened };
}

function make(serviceEnv: Record<string, Record<string, string>>) {
    const pty = fakePty();
    const supervisor = new ProcessSupervisor(pty.port, { now: () => 0, schedule: () => () => {} });
    let next = 4100;
    const deps = {
        supervisor,
        allocatePort: () => ++next,
        caddyBin: '/opt/genie/runtime/caddy',
        configDir: '/data/sites',
        writeConfig: () => {},
        serviceEnv: (workspaceId: string) => serviceEnv[workspaceId] ?? {},
    } as SiteManagerDeps;
    return { pty, sites: new SiteManager(deps) };
}

/** The env the newest php worker of a site was started with. */
const workerEnv = (opened: ReadonlyArray<PtySpawnOptions>) => [...opened].reverse().find((o) => /php-cgi -b /.test(o.command ?? ''))?.env ?? null;
const phpSite = { name: 'moicapp', workspaceId: 'moic', repoPath: '/repos/moic', serve: { mode: 'php' as const, root: 'public' } };

describe("a site's service env is read at every start", () => {
    it('a site declared BEFORE its engine existed gets the engine’s DB_PORT on restart (the moic timeline)', () => {
        const env: Record<string, Record<string, string>> = { moic: {} };
        const { pty, sites } = make(env);
        sites.create(phpSite);
        expect(workerEnv(pty.opened)?.DB_PORT).toBeUndefined(); // CONTROL: no engine yet, no DB_PORT
        env.moic = { DB_HOST: '127.0.0.1', DB_PORT: '4104' };
        sites.restart('site_moicapp');
        expect(workerEnv(pty.opened)).toMatchObject({ DB_HOST: '127.0.0.1', DB_PORT: '4104' });
    });

    it("the site's own env (its declared port variables) wins over the workspace's", () => {
        const { pty, sites } = make({ moic: { DB_PORT: '4104', APP_PORT: '1' } });
        sites.create({ ...phpSite, env: { APP_PORT: '8080' } });
        expect(workerEnv(pty.opened)).toMatchObject({ DB_PORT: '4104', APP_PORT: '8080' });
    });
});

describe('an engine change reaches running sites without anyone restarting them', () => {
    it("the workspace's RUNNING sites whose env changed are restarted with the new env; nothing else is touched", () => {
        const env: Record<string, Record<string, string>> = { moic: { DB_PORT: '4103' }, other: { DB_PORT: '5000' } };
        const { pty, sites } = make(env);
        sites.create(phpSite);
        sites.create({ ...phpSite, name: 'otherapp', workspaceId: 'other', repoPath: '/repos/other' });
        sites.create({ ...phpSite, name: 'idle', repoPath: '/repos/idle' });
        sites.stop('site_idle');
        const before = pty.opened.length;

        env.moic = { DB_PORT: '4104' };
        const restarted = sites.serviceEnvChanged('moic');

        expect(restarted).toEqual(['site_moicapp']); // not the other workspace's, not the stopped one
        const started = pty.opened.slice(before);
        expect(started.filter((o) => /php-cgi -b /.test(o.command ?? ''))).toHaveLength(1);
        expect(workerEnv(started)).toMatchObject({ DB_PORT: '4104' });
        expect(sites.list().find((s) => s.id === 'site_idle')?.state).toBe('stopped');
    });

    // Tynn #756, moic's acceptance run 11 (2026-10-17): the site read straight after `services detach` answered 502 —
    // an engine change stopped and restarted EVERY process of the site, Caddy included, on a NEW port the front door
    // did not route to yet. Only PHP reads the service env, so only the PHP worker is restarted, on the SAME fcgi port
    // (the site's Caddy retries the dial while it comes back: serve-config's lb_try_duration, measured in WSL).
    it('a PHP site: ONLY its worker is restarted, on the same fcgi port; its Caddy and its port are kept', () => {
        const env: Record<string, Record<string, string>> = { moic: { DB_PORT: '4103' } };
        const { pty, sites } = make(env);
        sites.create(phpSite);
        const portBefore = sites.list().find((s) => s.id === 'site_moicapp')?.port;
        const fcgiBefore = /php-cgi -b (\S+)/.exec(pty.opened.find((o) => /php-cgi -b /.test(o.command ?? ''))?.command ?? '')?.[1];
        const caddyBefore = pty.opened.filter((o) => /caddy run /.test(o.command ?? '')).length;
        expect(caddyBefore).toBe(1); // CONTROL: the gauge sees the site's Caddy
        const before = pty.opened.length;

        env.moic = { DB_PORT: '4104' };
        expect(sites.serviceEnvChanged('moic')).toEqual(['site_moicapp']);

        const started = pty.opened.slice(before);
        expect(started.filter((o) => /caddy run /.test(o.command ?? ''))).toHaveLength(0);
        const workers = started.filter((o) => /php-cgi -b /.test(o.command ?? ''));
        expect(workers).toHaveLength(1);
        expect(/php-cgi -b (\S+)/.exec(workers[0]!.command ?? '')?.[1]).toBe(fcgiBefore);
        expect(workers[0]!.env).toMatchObject({ DB_PORT: '4104' });
        const after = sites.list().find((s) => s.id === 'site_moicapp');
        expect(after?.port).toBe(portBefore);
        expect(after?.state).not.toBe('stopped');
        // and the NEXT change still compares against what the worker now runs with
        expect(sites.serviceEnvChanged('moic')).toEqual([]);
    });

    it('CONTROL: the same env again restarts nothing — a change event is not a change', () => {
        const env = { moic: { DB_PORT: '4104' } };
        const { pty, sites } = make(env);
        sites.create(phpSite);
        const before = pty.opened.length;
        expect(sites.serviceEnvChanged('moic')).toEqual([]);
        expect(pty.opened.length).toBe(before);
    });

    it('compose wires it: an engine change tells the sites, and the sites read the engines’ env at each start', () => {
        const compose = readFileSync('src/main/compose.ts', 'utf8');
        expect(compose).toMatch(/serviceEnv: \(workspaceId\) => engines\.envFor\(workspaceId\)/);
        expect(compose).toMatch(/sites\.serviceEnvChanged\(/);
    });
});
