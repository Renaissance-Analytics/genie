import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { request } from 'node:http';
import { createServer, connect } from 'node:net';
import { networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { serveCaddyfile } from '../src/core/serve-config.js';

/**
 * A SITE'S OWN CADDY, MEASURED WITH A REAL CADDY (the owner, 2026-10-14: "Zero *.gen sites are being served"; the
 * Windows acceptance then showed the front door answering every site with an empty 200).
 *
 * The front door forwards each request with the site's own name as Host. This runs the Caddyfile Genie writes, under the
 * pinned Caddy (`scripts/fetch-caddy.ts`), and asks it what the front door asks. It runs where GENIE_CADDY_BIN names
 * that binary (the row batch fetches it). Without it, the suite SAYS it was skipped rather than passing quietly.
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

const get = (host: string, port: number, hostHeader: string) => new Promise<{ status: number; body: string }>((resolve) => {
    const req = request({ host, port, path: '/', headers: { Host: hostHeader }, timeout: 3000 }, (res) => {
        let body = '';
        res.on('data', (c) => { body += c; });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', (e) => resolve({ status: 0, body: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: 'timeout' }); });
    req.end();
});

const reachable = (host: string, port: number) => new Promise<boolean>((resolve) => {
    const s = connect({ host, port, timeout: 2000 }, () => { s.destroy(); resolve(true); });
    s.on('error', () => resolve(false));
    s.on('timeout', () => { s.destroy(); resolve(false); });
});

/** The machine's own non-loopback IPv4 address: what another device on the network would connect to. */
const outsideAddress = () => Object.values(networkInterfaces()).flat().find((a) => a && a.family === 'IPv4' && !a.internal)?.address ?? null;

describe.skipIf(!bin)('a static site’s Caddy, as Genie writes it, under the real Caddy', () => {
    it('answers the front door’s request (Host: <name>.gen) with ITS page — and stays on loopback only', async () => {
        const repo = mkdtempSync(join(tmpdir(), 'genie2-site-'));
        dirs.push(repo);
        mkdirSync(join(repo, 'public'));
        const token = `site-${Date.now().toString(36)}`;
        writeFileSync(join(repo, 'public', 'index.html'), `<!doctype html><p>${token}</p>\n`);
        const port = await freePort();
        const file = join(repo, 'Caddyfile');
        writeFileSync(file, serveCaddyfile({ sitePort: port, repoPath: repo, serve: { mode: 'static', root: 'public', spa: false } })!);

        const caddy = spawn(bin!, ['run', '--config', file, '--adapter', 'caddyfile'], { stdio: 'ignore' });
        procs.push(caddy);
        let up = false;
        for (let i = 0; i < 50 && !up; i++) { up = await reachable('127.0.0.1', port); if (!up) await new Promise((r) => setTimeout(r, 200)); }
        expect(up).toBe(true);

        // What the front door sends: the site's own name.
        const viaFrontDoor = await get('127.0.0.1', port, 'accepta.gen');
        expect(viaFrontDoor.status).toBe(200);
        expect(viaFrontDoor.body).toContain(token);
        // POSITIVE CONTROL: a direct loopback request serves the same page.
        expect((await get('127.0.0.1', port, `127.0.0.1:${port}`)).body).toContain(token);

        // Loopback ONLY: the machine's outside address is refused, while loopback (above) answered.
        const outside = outsideAddress();
        expect(outside).not.toBeNull();
        expect(await reachable(outside!, port)).toBe(false);
    }, 30_000);
});

describe('when the real Caddy is not here', () => {
    it.runIf(!bin)('says so (the live check above did not run)', () => {
        console.warn('site-caddy-live: GENIE_CADDY_BIN is not set; the real-Caddy check was SKIPPED');
        expect(bin).toBeUndefined();
    });
});
