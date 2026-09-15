import { afterEach, describe, expect, it } from 'vitest';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { frankenphpCaddyfile, frankenphpRunArgv, parseFrankenphpVersion } from '../frankenphp';
import { phpIniContents } from '../toolchain-versions';
import { allocateFreePort, waitForHttp } from '../port-probe';

/**
 * REAL FrankenPHP serve mode — the official binary, the Caddyfile Genie writes,
 * and a PHP app that has to actually run (genie#668).
 *
 * A generated config either works or it does not, and only the real binary says
 * which: `php_server`'s `env` either reaches `$_SERVER` or it does not, and the
 * Windows build loads no php.ini at all unless one is where PHP looks. Unit tests
 * of the string prove neither.
 *
 * The binary is found at `FRANKENPHP_BIN` (the CI hosting job downloads the
 * official release there) or on PATH. Where there is none, the suite is skipped
 * rather than failed — a bare checkout has no reason to carry 160 MB.
 */

const frankenphp = (() => {
    const explicit = process.env.FRANKENPHP_BIN;
    if (explicit && existsSync(explicit)) return explicit;
    const which = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['frankenphp'], { encoding: 'utf8' });
    const first = (which.stdout || '').split(/\r?\n/).map((l) => l.trim()).find(Boolean);
    return which.status === 0 && first ? first : '';
})();

const procs: ChildProcess[] = [];
const dirs: string[] = [];
afterEach(async () => {
    // WAIT for each server to exit before deleting its directory: it runs from
    // the site's own folder, as a Genie site does, and Windows refuses to remove
    // a directory that is still some process's working directory.
    await Promise.all(
        procs.splice(0).map(
            (p) =>
                new Promise<void>((resolve) => {
                    if (p.exitCode !== null || p.signalCode !== null) return resolve();
                    p.once('exit', () => resolve());
                    p.kill();
                }),
        ),
    );
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

/**
 * On Windows, write the php.ini Genie writes for its own PHP installs beside the
 * binary — the zip is an official PHP layout (ext/ beside php8ts.dll) and loads
 * no ini otherwise. Static Linux/macOS builds compile their extensions in.
 */
function ensureIni(): void {
    if (process.platform !== 'win32') return;
    const dir = path.dirname(frankenphp);
    writeFileSync(path.join(dir, 'php.ini'), phpIniContents(dir, 'win32'));
}

async function serve(app: string): Promise<{ port: number; dir: string }> {
    ensureIni();
    const dir = mkdtempSync(path.join(tmpdir(), 'genie-real-frankenphp-'));
    dirs.push(dir);
    const root = path.join(dir, 'public');
    mkdirSync(path.join(root, 'build'), { recursive: true });
    writeFileSync(path.join(root, 'index.php'), app);
    writeFileSync(path.join(root, 'build', 'app.js'), 'export const ok = 1;');
    const uploads = path.join(dir, 'uploads');
    mkdirSync(uploads);
    const port = await allocateFreePort();
    const config = path.join(dir, 'Caddyfile');
    writeFileSync(config, frankenphpCaddyfile({ sitePort: port, root, uploadTmpDir: uploads }));
    const [bin, ...args] = frankenphpRunArgv(frankenphp, config);
    procs.push(spawn(bin!, args, { stdio: 'ignore', cwd: dir, env: { ...process.env, GENIE_E2E_PROBE: 'from-env' } }));
    expect(await waitForHttp(port, 30_000), 'FrankenPHP must answer on its allocated port').toBe(true);
    return { port, dir };
}

describe('REAL FrankenPHP serve mode', () => {
    it.skipIf(!frankenphp)('says what it is, in the form Genie parses', () => {
        const out = spawnSync(frankenphp, ['version'], { encoding: 'utf8' });
        expect(parseFrankenphpVersion(out.stdout)).not.toBeNull();
    });

    it.skipIf(!frankenphp)('EXECUTES PHP, tells it it is on https, and loads the extensions a Laravel app needs', async () => {
        const { port, dir } = await serve(`<?php
header('Content-Type: application/json');
echo json_encode([
  'php' => PHP_VERSION,
  'https' => $_SERVER['HTTPS'] ?? null,
  'serverPort' => $_SERVER['SERVER_PORT'] ?? null,
  'scheme' => $_SERVER['REQUEST_SCHEME'] ?? null,
  'uploadTmpDir' => ini_get('upload_tmp_dir'),
  'env' => $_ENV['GENIE_E2E_PROBE'] ?? null,
  'extensions' => array_map('strtolower', get_loaded_extensions()),
]);`);
        const res = await fetch(`http://127.0.0.1:${port}/some/route`);
        expect(res.status).toBe(200);
        const body = (await res.json()) as {
            php: string;
            https: string | null;
            serverPort: string | null;
            scheme: string | null;
            uploadTmpDir: string;
            env: string | null;
            extensions: string[];
        };
        expect(body.php).toMatch(/^\d+\.\d+\.\d+/);
        // The front controller answered an unmatched route, and PHP was told the truth.
        expect(body.https).toBe('on');
        expect(body.serverPort).toBe('443');
        expect(body.scheme).toBe('https');
        expect(body.uploadTmpDir.replace(/\\/g, '/')).toBe(path.join(dir, 'uploads').replace(/\\/g, '/'));
        expect(body.env, 'variables_order must populate $_ENV').toBe('from-env');
        for (const ext of ['mbstring', 'openssl', 'pdo_pgsql', 'pdo_mysql', 'fileinfo', 'curl', 'intl']) {
            expect(body.extensions, `extension ${ext}`).toContain(ext);
        }
    });

    it.skipIf(!frankenphp)('serves a static asset with its real Content-Type (genie#225)', async () => {
        const { port } = await serve('<?php echo "app";');
        const res = await fetch(`http://127.0.0.1:${port}/build/app.js`);
        expect(res.status).toBe(200);
        expect(await res.text()).toContain('export');
        expect(res.headers.get('content-type') ?? '').toMatch(/javascript|ecmascript/i);
    });

    it.skipIf(!frankenphp)('keeps serving far past php-cgi\'s 500-request limit', async () => {
        const { port } = await serve('<?php echo "alive";');
        for (let i = 0; i < 1200; i += 1) {
            const res = await fetch(`http://127.0.0.1:${port}/`);
            expect(await res.text(), `request ${i + 1}`).toContain('alive');
        }
    }, 120_000);
});
