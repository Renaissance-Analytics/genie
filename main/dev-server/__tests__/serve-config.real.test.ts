import { afterEach, describe, expect, it } from 'vitest';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { serveCaddyfile, caddyServeArgv, phpFastcgiWorkerCommand } from '../serve-config';
import { allocateFreePort, waitForHttp } from '../port-probe';

/**
 * REAL serve-mode test — launches the ACTUAL bundled Caddy against a real docroot
 * and asserts it SERVES over HTTP.
 *
 * The reason this file exists: the hosting E2E (`main/e2e/hosting.ts`) answers the
 * `dev:*` channels from an in-memory FIXTURE — it never runs a web server, never
 * allocates a real port, never serves a byte. So it proved nothing about whether a
 * `hostServe` site actually serves, which is exactly how broken hosting shipped
 * before (a serve mode that renders a plausible Caddyfile but 404s everything looks
 * identical to a working one until a human curls it). This runs the real binary and
 * curls it, so a broken serve config fails CI instead of the owner's afternoon.
 *
 * It lives in its OWN lane (`npm run test:hosting`), NOT the fast unit `npm test`:
 * it spawns a real process and binds a real loopback port, and it needs the bundled
 * Caddy that `npm run build:runtime` produces — present in a built app and on the CI
 * hosting job, absent from a bare checkout. When the binary is missing the lane
 * fails loudly (the whole point is that the test RUNS), naming the build step.
 */

const caddyBin = path.resolve(
    process.cwd(),
    'resources',
    'runtime',
    process.platform === 'win32' ? 'caddy.exe' : 'caddy',
);

const procs: ChildProcess[] = [];
const dirs: string[] = [];

afterEach(() => {
    for (const p of procs.splice(0)) p.kill();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Write a `dist/index.html` carrying `marker`, render the REAL static Caddyfile,
 *  launch the REAL bundled Caddy against it, and wait until it answers. Returns the
 *  loopback port it is serving on. */
async function serveStatic(spa: boolean, marker: string): Promise<number> {
    const dir = mkdtempSync(path.join(tmpdir(), 'genie-real-static-'));
    dirs.push(dir);
    const root = path.join(dir, 'dist');
    mkdirSync(root);
    writeFileSync(
        path.join(root, 'index.html'),
        `<!doctype html><meta charset="utf-8"><title>${marker}</title>${marker}`,
    );
    const sitePort = await allocateFreePort();
    const configPath = path.join(dir, 'Caddyfile');
    writeFileSync(configPath, serveCaddyfile({ sitePort, serve: { kind: 'static', root, spa } }));
    const [bin, ...args] = caddyServeArgv(caddyBin, configPath);
    const child = spawn(bin!, args, { stdio: 'ignore' });
    procs.push(child);
    const up = await waitForHttp(sitePort, 15_000);
    expect(up, `the bundled Caddy (${caddyBin}) must answer on 127.0.0.1:${sitePort}`).toBe(true);
    return sitePort;
}

describe('REAL static serve mode — the bundled Caddy actually serves the folder', () => {
    it('serves index.html from the built directory', async () => {
        const marker = 'GENIE-REAL-STATIC-ROOT';
        const port = await serveStatic(true, marker);
        const res = await fetch(`http://127.0.0.1:${port}/`);
        expect(res.status).toBe(200);
        expect(await res.text()).toContain(marker);
    });

    it('SPA fallback resolves a deep client-side route to index.html', async () => {
        // A deep link with no matching file must fall back to index.html (the exact
        // try_files an agent hand-wrote before hostServe). A 404 here = broken SPA.
        const marker = 'GENIE-REAL-STATIC-SPA';
        const port = await serveStatic(true, marker);
        const res = await fetch(`http://127.0.0.1:${port}/deep/link/that/does/not/exist`);
        expect(res.status).toBe(200);
        expect(await res.text()).toContain(marker);
    });

    it('WITHOUT the SPA flag, an unmatched path 404s — no accidental catch-all', async () => {
        const port = await serveStatic(false, 'GENIE-REAL-STATIC-NOSPA');
        const res = await fetch(`http://127.0.0.1:${port}/does-not-exist.html`);
        expect(res.status).toBe(404);
    });
});

/** Is `php-cgi` on PATH (the exact binary production's worker command spawns)? The
 *  CI hosting job installs it; a bare dev box may not, so the php test is gated on
 *  it rather than failing where PHP is simply absent. */
const hasPhpCgi = (() => {
    try {
        return spawnSync('php-cgi', ['--version'], { stdio: 'ignore' }).status === 0;
    } catch {
        return false;
    }
})();

describe('REAL php serve mode — the bundled Caddy + php-cgi actually EXECUTE PHP', () => {
    it.skipIf(!hasPhpCgi)('serves executed PHP from public/ over the FastCGI worker', async () => {
        const dir = mkdtempSync(path.join(tmpdir(), 'genie-real-php-'));
        dirs.push(dir);
        const root = path.join(dir, 'public');
        mkdirSync(root);
        const marker = 'GENIE-REAL-PHP-OK';
        // If php_fastcgi were wired wrong this is served as TEXT (source leak); if it
        // works the browser gets the evaluated output + a resolved PHP version.
        writeFileSync(path.join(root, 'index.php'), `<?php echo "${marker} ".PHP_VERSION;`);

        const sitePort = await allocateFreePort();
        const fcgiPort = await allocateFreePort(new Set([sitePort]));
        const [wbin, ...wargs] = phpFastcgiWorkerCommand(fcgiPort);
        procs.push(spawn(wbin!, wargs, { stdio: 'ignore' }));

        const configPath = path.join(dir, 'Caddyfile');
        writeFileSync(configPath, serveCaddyfile({ sitePort, serve: { kind: 'php', root, fcgiPort } }));
        const [bin, ...args] = caddyServeArgv(caddyBin, configPath);
        procs.push(spawn(bin!, args, { stdio: 'ignore' }));

        expect(await waitForHttp(sitePort, 15_000), 'Caddy + php-cgi must answer').toBe(true);
        const res = await fetch(`http://127.0.0.1:${sitePort}/`);
        expect(res.status).toBe(200);
        const body = await res.text();
        expect(body).toContain(marker);
        expect(body, 'PHP must have EXECUTED, not been served as source').toMatch(/\d+\.\d+\.\d+/);
        expect(body).not.toContain('<?php');
    });
});
