import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { connect, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { serveCaddyfile } from '../src/core/serve-config.js';

/**
 * PHP SEES THE REQUEST AS HTTPS — measured with the REAL pinned Caddy and a REAL php-cgi (the moic agent, 2026-10-14:
 * moic.gen rendered every page blank; its HTML linked `http://moic.gen/build/...` assets on an https page). Runs where
 * GENIE_CADDY_BIN names the pinned Caddy and `php-cgi` is on PATH; otherwise it SAYS it was skipped.
 */
const bin = process.env['GENIE_CADDY_BIN'];
const phpCgi = (() => { try { return execFileSync('sh', ['-c', 'command -v php-cgi'], { encoding: 'utf8' }).trim() || null; } catch { return null; } })();
const dirs: string[] = [];
const procs: ChildProcess[] = [];
afterAll(() => { for (const p of procs) p.kill(); for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

const freePort = () => new Promise<number>((resolve) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = (s.address() as { port: number }).port; s.close(() => resolve(p)); }); });
const reachable = (port: number) => new Promise<boolean>((resolve) => { const s = connect({ host: '127.0.0.1', port, timeout: 1000 }, () => { s.destroy(); resolve(true); }); s.on('error', () => resolve(false)); s.on('timeout', () => { s.destroy(); resolve(false); }); });
const get = (port: number, host: string) => new Promise<string>((resolve) => {
    const req = request({ host: '127.0.0.1', port, path: '/index.php', headers: { Host: host }, timeout: 5000 }, (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve(b)); });
    req.on('error', (e) => resolve(`ERROR ${e.message}`)); req.end();
});

describe.skipIf(!bin || !phpCgi)('a PHP site behind its own Caddy, as Genie writes it', () => {
    it('PHP reports the request as HTTPS (HTTPS=on, scheme https, port 443) for the front door’s Host', async () => {
        const repo = mkdtempSync(join(tmpdir(), 'genie2-php-'));
        dirs.push(repo);
        mkdirSync(join(repo, 'public'));
        writeFileSync(join(repo, 'public', 'index.php'), "<?php echo ($_SERVER['HTTPS'] ?? 'off'), '|', ($_SERVER['REQUEST_SCHEME'] ?? ''), '|', ($_SERVER['SERVER_PORT'] ?? '');\n");
        const [sitePort, fcgiPort] = [await freePort(), await freePort()];
        const file = join(repo, 'Caddyfile');
        writeFileSync(file, serveCaddyfile({ sitePort, repoPath: repo, serve: { mode: 'php', root: 'public', fcgiPort } })!);
        procs.push(spawn(phpCgi!, ['-b', `127.0.0.1:${fcgiPort}`], { stdio: 'ignore' }));
        procs.push(spawn(bin!, ['run', '--config', file, '--adapter', 'caddyfile'], { stdio: 'ignore' }));
        let up = false;
        for (let i = 0; i < 50 && !up; i++) { up = (await reachable(sitePort)) && (await reachable(fcgiPort)); if (!up) await new Promise((r) => setTimeout(r, 200)); }
        expect(up).toBe(true);
        expect(await get(sitePort, 'moic.example.gen')).toBe('on|https|443');
    }, 30_000);
});

describe('when the real Caddy or php-cgi is not here', () => {
    it.runIf(!bin || !phpCgi)('says so (the live check above did not run)', () => {
        console.warn(`site-php-https-live: SKIPPED — GENIE_CADDY_BIN ${bin ? 'set' : 'unset'}, php-cgi ${phpCgi ?? 'not on PATH'}`);
        expect(!bin || !phpCgi).toBe(true);
    });
});
