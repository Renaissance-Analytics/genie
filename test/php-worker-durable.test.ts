import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { connect, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { serveCaddyfile } from '../src/core/serve-config.js';
import type { PtyOpened, PtyPort, PtySpawnOptions } from '../src/main/terminal-host.js';
import { ProcessSupervisor } from '../src/main/process-supervisor.js';
import * as siteManager from '../src/main/site-manager.js';

/**
 * A PHP SITE NEVER GOES DOWN BY ITSELF (Genie 1 #664/#665, lost in Genie 2; the owner, 2026-10-16: "we are supposed to
 * be moving forward, not regressing"). `php-cgi` in FastCGI mode EXITS ON ITS OWN after PHP_FCGI_MAX_REQUESTS
 * requests — 500 by default — with status 0, and refuses the next. Genie 2 set nothing, and its worker restarts only
 * on FAILURE, so a clean exit left the site answering 502 for good.
 *
 * So: the worker runs with PHP_FCGI_MAX_REQUESTS=0 (no request limit), and comes back whenever it exits, cleanly or
 * not. Proven on the real binary below: 520 requests through the generated Caddyfile all answer; the CONTROL — a bare
 * worker — refuses one past 500, so the gauge can see the failure it names.
 */

function fakePty() {
    const opened: Array<PtySpawnOptions & { id: string }> = [];
    const exits = new Set<(id: string, code: number) => void>();
    let n = 0;
    const port: PtyPort = {
        open(options) {
            const id = `term_${++n}`;
            opened.push({ ...options, id });
            return { id, pid: 5000 + n, shell: options.command ?? 'sh', scrollback: '' } satisfies PtyOpened;
        },
        write: () => true, resize: () => true, kill: () => true, scrollback: () => '',
        onData: () => () => {},
        onExit: (l) => { exits.add(l); return () => exits.delete(l); },
    };
    return { port, opened, exit: (id: string, code: number) => { for (const l of exits) l(id, code); } };
}

function make() {
    const pty = fakePty();
    // Restarts run at once: what is measured is WHETHER the worker comes back, not the backoff.
    const supervisor = new ProcessSupervisor(pty.port, { now: () => 0, schedule: (fn: () => void) => { fn(); return () => {}; } } as never);
    let next = 4200;
    const sites = new siteManager.SiteManager({ supervisor, allocatePort: () => ++next, caddyBin: '/opt/genie/runtime/caddy', configDir: '/data/sites', writeConfig: () => {}, phpWorkers: 1 });
    return { pty, sites };
}
const workers = (opened: ReadonlyArray<PtySpawnOptions & { id: string }>) => opened.filter((o) => /php-cgi -b /.test(o.command ?? ''));
const phpSite = { name: 'moicapp', workspaceId: 'moic', repoPath: '/repos/moic', serve: { mode: 'php' as const, root: 'public' } };

describe('the PHP worker Genie starts', () => {
    it('runs with PHP_FCGI_MAX_REQUESTS=0, so it never exits on a request count', () => {
        const { pty, sites } = make();
        sites.create(phpSite);
        expect(workers(pty.opened)).toHaveLength(1);
        expect(workers(pty.opened)[0]!.env?.PHP_FCGI_MAX_REQUESTS).toBe('0');
    });

    it('comes back after a CLEAN exit (code 0) — the exit php-cgi makes at its request limit', () => {
        const { pty, sites } = make();
        sites.create(phpSite);
        const first = workers(pty.opened)[0]!;
        pty.exit(first.id, 0);
        expect(workers(pty.opened)).toHaveLength(2);
        expect(workers(pty.opened)[1]!.env?.PHP_FCGI_MAX_REQUESTS).toBe('0');
    });

    it('CONTROL: a site the person STOPS stays stopped — its worker is not brought back', () => {
        const { pty, sites } = make();
        sites.create(phpSite);
        sites.stop('site_moicapp');
        const count = workers(pty.opened).length;
        const last = workers(pty.opened).at(-1)!;
        pty.exit(last.id, 0);
        expect(workers(pty.opened)).toHaveLength(count);
    });
});

// ---- the real binary: php-cgi + Genie's Caddy, as the live https test runs them ----------------------------------
const which = (cmd: string): string | null => { try { return execFileSync('sh', ['-c', `command -v ${cmd}`], { encoding: 'utf8' }).trim() || null; } catch { return null; } };
const bin = process.env.GENIE_CADDY_BIN ?? null;
const phpCgi = process.platform === 'win32' ? null : which('php-cgi');
const procs: ChildProcess[] = [];
const dirs: string[] = [];
afterAll(() => { for (const p of procs) p.kill('SIGKILL'); for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const freePort = () => new Promise<number>((resolve) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = (s.address() as { port: number }).port; s.close(() => resolve(p)); }); });
const reachable = (port: number) => new Promise<boolean>((resolve) => { const s = connect({ host: '127.0.0.1', port, timeout: 1000 }, () => { s.destroy(); resolve(true); }); s.on('error', () => resolve(false)); s.on('timeout', () => { s.destroy(); resolve(false); }); });
const status = (port: number) => new Promise<number>((resolve) => {
    const req = request({ host: '127.0.0.1', port, path: '/index.php', headers: { Host: 'moic.example.gen' }, timeout: 5000 }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode ?? 0)); });
    req.on('error', () => resolve(0));
    req.on('timeout', () => { req.destroy(); resolve(0); });
    req.end();
});

async function servePhp(workerEnv: Record<string, string>): Promise<number> {
    const repo = mkdtempSync(join(tmpdir(), 'genie2-php500-'));
    dirs.push(repo);
    mkdirSync(join(repo, 'public'));
    writeFileSync(join(repo, 'public', 'index.php'), '<?php echo "ok";\n');
    const [sitePort, fcgiPort] = [await freePort(), await freePort()];
    const file = join(repo, 'Caddyfile');
    writeFileSync(file, serveCaddyfile({ sitePort, repoPath: repo, serve: { mode: 'php', root: 'public', fcgiPort } })!);
    const env = { ...process.env };
    delete env.PHP_FCGI_MAX_REQUESTS;
    procs.push(spawn(phpCgi!, ['-b', `127.0.0.1:${fcgiPort}`], { stdio: 'ignore', env: { ...env, ...workerEnv } }));
    procs.push(spawn(bin!, ['run', '--config', file, '--adapter', 'caddyfile'], { stdio: 'ignore' }));
    let up = false;
    for (let i = 0; i < 50 && !up; i++) { up = (await reachable(sitePort)) && (await reachable(fcgiPort)); if (!up) await new Promise((r) => setTimeout(r, 200)); }
    expect(up).toBe(true);
    return sitePort;
}
const answeredOf = async (port: number, count: number) => { let ok = 0; for (let i = 0; i < count; i++) if ((await status(port)) === 200) ok++; return ok; };

describe.skipIf(!bin || !phpCgi)('the real php-cgi behind Genie’s Caddy', () => {
    it('CONTROL: a bare worker stops answering after 500 requests — the failure this measures', async () => {
        const port = await servePhp({});
        expect(await answeredOf(port, 520)).toBe(500);
    }, 120_000);

    it("with Genie's worker env, 520 requests are all answered", async () => {
        const env = (siteManager as { PHP_WORKER_ENV?: Record<string, string> }).PHP_WORKER_ENV ?? {};
        const port = await servePhp(env);
        expect(await answeredOf(port, 520)).toBe(520);
    }, 120_000);
});
