import { spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { connect, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { parseCommandLine } from '@particle-academy/fancy-term-host';
import { afterAll, describe, expect, it } from 'vitest';
import { serveCaddyfile } from '../src/core/serve-config.js';
import type { PtyOpened, PtyPort, PtySpawnOptions } from '../src/main/terminal-host.js';
import { ProcessSupervisor } from '../src/main/process-supervisor.js';
import { SiteManager } from '../src/main/site-manager.js';

/**
 * A SITE IN A FOLDER WHOSE PATH HAS A SPACE (Tynn #729; a client's first workspace, "Genie Trials", beta.63): Caddy
 * exited right after loading. Genie 2's per-site Caddyfile wrote `root * <path>` bare. Genie 1's quoteRoot() never came
 * across in the fold, so Caddy read `Trials/...` as extra arguments to `root` and refused the config. The command line
 * the supervisor runs also named the Caddy binary and the Caddyfile bare, which breaks the same way for a profile with
 * a space in it (both live under the install and config folders).
 */

const SPACED = '/home/a b/Genie Trials';

const rootLine = (caddyfile: string) => caddyfile.split('\n').find((l) => l.startsWith('\troot * ')) ?? '';

describe('the per-site Caddyfile names its root as ONE argument', () => {
    it('static: a repo path with a space is quoted', () => {
        const c = serveCaddyfile({ sitePort: 4101, repoPath: SPACED, storageDir: '/data/s', serve: { mode: 'static', root: 'dist', spa: true } })!;
        expect(rootLine(c)).toBe('\troot * "/home/a b/Genie Trials/dist"');
    });

    it('php: a repo path with a space is quoted', () => {
        const c = serveCaddyfile({ sitePort: 4101, repoPath: SPACED, storageDir: '/data/s', serve: { mode: 'php', root: 'public', fcgiPort: 4102 } })!;
        expect(rootLine(c)).toBe('\troot * "/home/a b/Genie Trials/public"');
    });

    it('a Windows path with a space: quoted, with forward slashes', () => {
        const c = serveCaddyfile({ sitePort: 4101, repoPath: 'C:\\Users\\x\\Genie Trials', storageDir: 'C:\\d\\s', serve: { mode: 'static', root: 'public', spa: false } })!;
        expect(rootLine(c)).toBe('\troot * "C:/Users/x/Genie Trials/public"');
    });

    it('a repo path that cannot be written into a Caddyfile is refused, naming it', () => {
        expect(() => serveCaddyfile({ sitePort: 4101, repoPath: '/home/a"b', storageDir: '/data/s', serve: { mode: 'static', root: 'dist', spa: false } })).toThrow(/cannot be written into a Caddyfile/);
    });

    it('CONTROL: the storage line with a space was already one quoted argument', () => {
        const c = serveCaddyfile({ sitePort: 4101, repoPath: '/r', storageDir: '/data/Genie Data/s', serve: { mode: 'static', root: 'dist', spa: false } })!;
        expect(c).toContain('\tstorage file_system "/data/Genie Data/s"');
    });
});

function fakePty() {
    const opened: Array<PtySpawnOptions & { id: string }> = [];
    let n = 0;
    const port: PtyPort = {
        open(options) {
            const id = `term_${++n}`;
            opened.push({ ...options, id });
            return { id, pid: 2000 + n, shell: options.command ?? 'sh', scrollback: '' } satisfies PtyOpened;
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

/** The command line SiteManager hands the supervisor for a static site, and the Caddyfile it wrote. */
function staticSite(caddyBin: string, configDir: string, repoPath: string, port = 4101) {
    const pty = fakePty();
    const written: Array<{ path: string; content: string }> = [];
    const sites = new SiteManager({
        supervisor: new ProcessSupervisor(pty.port, { now: () => 0, schedule: () => () => {} }),
        allocatePort: () => port,
        caddyBin,
        configDir,
        writeConfig: (path, content) => { written.push({ path, content }); },
        phpWorkers: 1,
    });
    sites.create({ name: 'game', workspaceId: 'w', repoPath, serve: { mode: 'static', root: 'public', spa: false } });
    return { command: pty.opened[0]!.command!, written };
}

describe('the Caddy command line the supervisor runs', () => {
    it('a Caddy binary and a config folder with a space: each is one quoted word', () => {
        const { command } = staticSite('/opt/Genie App/caddy', '/data/Genie Data/sites', '/repos/game');
        expect(command).toBe(`"/opt/Genie App/caddy" run --config "${join('/data/Genie Data/sites', 'site_game', 'Caddyfile')}" --adapter caddyfile`);
    });

    it('CONTROL: with no space, the pty parser reads the binary and the Caddyfile as they are', () => {
        const { command } = staticSite('/opt/genie/caddy', '/data/sites', '/repos/game');
        expect(parseCommandLine(command)).toEqual({ command: '/opt/genie/caddy', args: ['run', '--config', join('/data/sites', 'site_game', 'Caddyfile'), '--adapter', 'caddyfile'] });
    });

    it('with a space, the pty parser still reads the binary and the Caddyfile whole', () => {
        const { command } = staticSite('/opt/Genie App/caddy', '/data/Genie Data/sites', '/repos/game');
        expect(parseCommandLine(command)).toEqual({ command: '/opt/Genie App/caddy', args: ['run', '--config', join('/data/Genie Data/sites', 'site_game', 'Caddyfile'), '--adapter', 'caddyfile'] });
    });
});

/**
 * THE REAL CADDY (the pinned one, `scripts/fetch-caddy.ts`; the job names it in GENIE_CADDY_BIN). The site is started as
 * Genie starts it: SiteManager's own command line, read by the pty's parser, the Caddyfile it wrote.
 */
const bin = process.env['GENIE_CADDY_BIN'];
const dirs: string[] = [];
const procs: ChildProcess[] = [];
afterAll(() => {
    for (const p of procs) p.kill();
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const freePort = () => new Promise<number>((resolve) => {
    const s = createServer();
    s.listen(0, '127.0.0.1', () => { const port = (s.address() as { port: number }).port; s.close(() => resolve(port)); });
});

const reachable = (port: number) => new Promise<boolean>((resolve) => {
    const s = connect({ host: '127.0.0.1', port, timeout: 1000 }, () => { s.destroy(); resolve(true); });
    s.on('error', () => resolve(false));
    s.on('timeout', () => { s.destroy(); resolve(false); });
});

const body = (port: number) => new Promise<string>((resolve) => {
    const req = request({ host: '127.0.0.1', port, path: '/', headers: { Host: 'game.gen' }, timeout: 3000 }, (res) => {
        let b = '';
        res.on('data', (c) => { b += c; });
        res.on('end', () => resolve(b));
    });
    req.on('error', (e) => resolve(`error: ${e.message}`));
    req.on('timeout', () => { req.destroy(); resolve('timeout'); });
    req.end();
});

/** Start the site the way Genie does under `folder` (a name with or without a space) and return the page it serves. */
async function serveFrom(folder: string): Promise<{ page: string; exited: number | null }> {
    const base = mkdtempSync(join(tmpdir(), 'genie-729-'));
    dirs.push(base);
    const home = join(base, folder);
    const repo = join(home, 'repos', 'game');
    mkdirSync(join(repo, 'public'), { recursive: true });
    const token = `game-${Date.now().toString(36)}`;
    writeFileSync(join(repo, 'public', 'index.html'), `<!doctype html><p>${token}</p>\n`);
    // The binary and the config folder live under the same folder, as Genie's install and config do under a profile.
    const binDir = join(home, 'app');
    mkdirSync(binDir, { recursive: true });
    const caddy = join(binDir, basename(bin!));
    copyFileSync(bin!, caddy);
    chmodSync(caddy, 0o755);
    const configDir = join(home, 'config', 'sites');
    const port = await freePort();
    const { command, written } = staticSite(caddy, configDir, repo, port);
    for (const w of written) { mkdirSync(join(w.path, '..'), { recursive: true }); writeFileSync(w.path, w.content); }
    const parsed = parseCommandLine(command);
    const child = spawn(parsed.command, parsed.args, { stdio: 'ignore' });
    procs.push(child);
    let exited: number | null = null;
    child.on('exit', (code) => { exited = code ?? -1; });
    child.on('error', () => { exited = -2; });
    let up = false;
    for (let i = 0; i < 50 && !up && exited === null; i++) { up = await reachable(port); if (!up) await new Promise((r) => setTimeout(r, 200)); }
    const page = up ? await body(port) : `not serving (exit ${exited})`;
    return { page: page.includes(token) ? 'served' : page, exited };
}

describe.skipIf(!bin)('the real Caddy, started as Genie starts a static site', () => {
    it('CONTROL: from a folder with no space, the site serves its page', async () => {
        expect((await serveFrom('GenieTrials')).page).toBe('served');
    }, 30_000);

    it('from "Genie Trials" (the binary, the Caddyfile and the repo all under it), the site serves its page', async () => {
        expect((await serveFrom('Genie Trials')).page).toBe('served');
    }, 30_000);
});
