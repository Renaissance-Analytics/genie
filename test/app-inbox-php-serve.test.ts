import { describe, expect, it } from 'vitest';
import { laravelServeCommand } from '../src/core/serve-config.js';
import type { AppEnvSource } from '../src/main/app-inbox-service.js';
import { ProcessSupervisor } from '../src/main/process-supervisor.js';
import { SiteManager, type SiteManagerDeps } from '../src/main/site-manager.js';
import type { PtyOpened, PtyPort, PtySpawnOptions } from '../src/main/terminal-host.js';

/**
 * A PHP SITE'S OWN APP CREDENTIAL MUST REACH ITS SERVED REQUESTS (genie#1376; fancy, 2026-10-31: on flabs.gen,
 * `GENIE_INBOX_URL` / `GENIE_INBOX_TOKEN` were absent from every served PHP request after beta.53).
 *
 * Genie put the token in the site's process env, and the unit suite proved that much (app-inbox-env.test.ts). What it
 * never asked is whether the PHP that ANSWERS A REQUEST can read it. flabs runs `php artisan serve` (Genie's own
 * default for a Laravel repo, serve-config.ts detectDevServer). That command does not serve: it starts a `php -S` CHILD,
 * and when the app has a `.env` it hands that child every `$_ENV` key set to `false` — removed — except a short
 * passthrough list (Laravel `ServeCommand::startProcess`, `$passthroughVariables`). Genie's own php.ini says
 * `variables_order = "EGPCS"` (core/php-versions.ts, genie#539), so `$_ENV` in the artisan process IS the whole process
 * env: the token was scrubbed before the first request. The service env (DB_*) survived only because DotEnvSync writes
 * it into `.env`, which the child reads again — and the token must never be written there.
 *
 * Measured in omarchy-test with a real Laravel 13 app and the real Caddy + php-cgi (test/live/app-inbox-php.live.ts).
 */

const URL_ = 'http://127.0.0.1:47432';
const appEnv = (s: AppEnvSource) => ({ GENIE_INBOX_URL: URL_, GENIE_INBOX_TOKEN: `gik_${s.kind}_${s.id}` });

describe('laravelServeCommand: `artisan serve` runs its own PHP without $_ENV, so Laravel hands Genie’s env to the server', () => {
    it('Genie’s detected default gets `-d variables_order=GPCS` on the artisan process', () => {
        expect(laravelServeCommand('php artisan serve --host=127.0.0.1 --port=8091')).toBe('php -d variables_order=GPCS artisan serve --host=127.0.0.1 --port=8091');
    });

    it('any php binary: a path, a versioned name, Windows’ php.exe (quoted or not)', () => {
        expect(laravelServeCommand('/usr/bin/php artisan serve')).toBe('/usr/bin/php -d variables_order=GPCS artisan serve');
        expect(laravelServeCommand('php8.4 artisan serve --port=1')).toBe('php8.4 -d variables_order=GPCS artisan serve --port=1');
        expect(laravelServeCommand('C:\\php\\php.exe artisan serve')).toBe('C:\\php\\php.exe -d variables_order=GPCS artisan serve');
        expect(laravelServeCommand('"C:\\Program Files\\php\\php.exe" artisan serve')).toBe('"C:\\Program Files\\php\\php.exe" -d variables_order=GPCS artisan serve');
    });

    it('anything else is left exactly as written', () => {
        for (const c of [
            'npm run dev -- --port 8091',
            'php -S 127.0.0.1:8091 -t public',
            'php artisan octane:start --port=8091',
            'php artisan queue:work',
            'frankenphp php-server --listen 127.0.0.1:8091',
            'php -d variables_order=EGPCS artisan serve', // the person chose; theirs stands
            'phpunit artisan serve',
        ]) expect(laravelServeCommand(c)).toBe(c);
    });
});

function fakePty() {
    const opened: Array<PtySpawnOptions & { id: string }> = [];
    let n = 0;
    const port: PtyPort = {
        open(options) { const id = `term_${++n}`; opened.push({ ...options, id }); return { id, pid: 3000 + n, shell: options.command ?? 'sh', scrollback: '' } satisfies PtyOpened; },
        write: () => true, resize: () => true, kill: () => true, scrollback: () => '', onData: () => () => {}, onExit: () => () => {},
    };
    return { port, opened };
}

function make() {
    const pty = fakePty();
    const supervisor = new ProcessSupervisor(pty.port, { now: () => 0, schedule: () => () => {} });
    const written = new Map<string, string>();
    let next = 4100;
    const deps = {
        supervisor, allocatePort: () => ++next, caddyBin: '/opt/genie/runtime/caddy', configDir: '/data/sites',
        writeConfig: (path: string, content: string) => { written.set(path, content); }, phpWorkers: 2,
        serviceEnv: () => ({ DB_PORT: '4104' }), appEnv,
    } as SiteManagerDeps;
    return { pty, written, sites: new SiteManager(deps) };
}

describe('a Laravel dev-server site: its token reaches the server that answers requests', () => {
    it('`php artisan serve` is started with the artisan process’s $_ENV empty, and with THIS site’s token in its env', () => {
        const { pty, sites } = make();
        sites.create({ name: 'flabs', workspaceId: 'fancy', repoPath: '/repos/flabs', serve: { mode: 'proxy' }, devServer: { stack: 'laravel', command: 'php artisan serve --host=127.0.0.1 --port={port}' } });
        const dev = pty.opened.find((o) => /artisan serve/.test(o.command ?? ''));
        expect(dev?.command).toMatch(/^php -d variables_order=GPCS artisan serve --host=127\.0\.0\.1 --port=\d+$/);
        expect(dev?.env).toMatchObject({ DB_PORT: '4104', GENIE_INBOX_URL: URL_, GENIE_INBOX_TOKEN: 'gik_site_site_flabs' });
    });

    it('two Laravel sites: each its own token, never the other’s', () => {
        const { pty, sites } = make();
        sites.create({ name: 'flabs', workspaceId: 'fancy', repoPath: '/repos/flabs', serve: { mode: 'proxy' }, devServer: { stack: 'laravel', command: 'php artisan serve --port={port}' } });
        sites.create({ name: 'fancy', workspaceId: 'fancy', repoPath: '/repos/fancy', serve: { mode: 'proxy' }, devServer: { stack: 'laravel', command: 'php artisan serve --port={port}' } });
        const tokens = pty.opened.filter((o) => /artisan serve/.test(o.command ?? '')).map((o) => o.env?.GENIE_INBOX_TOKEN);
        expect(tokens).toEqual(['gik_site_site_flabs', 'gik_site_site_fancy']);
    });
});

describe('a php site (Caddy + php-cgi): its token rides its OWN workers’ env, and never a file', () => {
    it('every worker of site A carries A’s token, every worker of B carries B’s, and neither Caddyfile names a token', () => {
        const { pty, written, sites } = make();
        sites.create({ name: 'flabs', workspaceId: 'fancy', repoPath: '/repos/flabs', serve: { mode: 'php', root: 'public' } });
        sites.create({ name: 'other', workspaceId: 'fancy', repoPath: '/repos/other', serve: { mode: 'php', root: 'public' } });
        const workers = pty.opened.filter((o) => /php-cgi -b /.test(o.command ?? ''));
        expect(workers).toHaveLength(4); // CONTROL: two workers per site were started
        const byName = (n: string) => workers.filter((o) => o.cwd.endsWith(n));
        for (const w of byName('flabs')) expect(w.env?.GENIE_INBOX_TOKEN).toBe('gik_site_site_flabs');
        for (const w of byName('other')) expect(w.env?.GENIE_INBOX_TOKEN).toBe('gik_site_site_other');
        expect(byName('flabs')).toHaveLength(2);
        expect(byName('other')).toHaveLength(2);
        const caddyfiles = [...written.entries()].filter(([p]) => p.endsWith('Caddyfile'));
        expect(caddyfiles).toHaveLength(2); // CONTROL: both were written
        for (const [, text] of caddyfiles) {
            expect(text).toContain('php_fastcgi'); // CONTROL: the PHP block is the one we read
            expect(text).not.toMatch(/gik_|GENIE_INBOX/);
        }
    });
});
