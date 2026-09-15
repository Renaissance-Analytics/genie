import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { caddyServeArgv, phpFastcgiWorkerCommand, serveCaddyfile } from '../serve-config';
import { allocateFreePort, waitForHttp } from '../port-probe';
import {
    PHP_REQUIRED_MODULES,
    TOOLCHAIN_RECIPES,
    assetFor,
    parsePhpThreadSafety,
    phpIniContents,
    phpThreadSafeDll,
} from '../toolchain-versions';
import { parseModuleList } from '../toolchain-version-install';

/**
 * REAL: the PHP Genie installs on Windows is thread-safe AND serves (genie#669).
 *
 * The unit tests pin the URL and the checks. Only the vendor's real zip can
 * answer the two things that matter: that the file at that URL is a ZTS build,
 * and that its `php-cgi.exe` — which the php serve mode spawns — still serves a
 * request behind Genie's own Caddy with Genie's own php.ini. NTS was once chosen
 * precisely because it is "the FastCGI build", so the second is not a given.
 *
 * Windows only, because these are Windows builds: the `hosting-windows` CI job
 * runs it. It downloads from the SAME URLs the recipe names, unpacks with the
 * same `Expand-Archive` Genie's installer uses, and writes the same php.ini.
 */

const isWindows = process.platform === 'win32';
const recipe = TOOLCHAIN_RECIPES.find((r) => r.tool === 'php' && r.version === '8.4.24')!;
const caddyBin = path.resolve(process.cwd(), 'resources', 'runtime', 'caddy.exe');

const procs: ChildProcess[] = [];
let work = '';
let phpDir = '';

async function download(urls: string[], dest: string): Promise<void> {
    const errors: string[] = [];
    for (const url of urls) {
        try {
            const res = await fetch(url);
            if (!res.ok) {
                errors.push(`${url}: HTTP ${res.status}`);
                continue;
            }
            writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
            return;
        } catch (e) {
            errors.push(`${url}: ${String(e)}`);
        }
    }
    throw new Error(`could not download the recipe's zip — ${errors.join('; ')}`);
}

describe.skipIf(!isWindows)('REAL Windows PHP — the thread-safe build Genie installs', () => {
    beforeAll(async () => {
        work = mkdtempSync(path.join(tmpdir(), 'genie-real-zts-'));
        phpDir = path.join(work, 'php', recipe.version);
        mkdirSync(phpDir, { recursive: true });
        const zip = path.join(work, 'php.zip');
        await download(assetFor(recipe, { os: 'win32', arch: 'x64' })!.urls, zip);
        const unpack = spawnSync(
            'powershell',
            ['-NoProfile', '-NonInteractive', '-Command', `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${phpDir}' -Force`],
            { encoding: 'utf8' },
        );
        expect(unpack.status, unpack.stderr).toBe(0);
        writeFileSync(path.join(phpDir, 'php.ini'), phpIniContents(phpDir, 'win32'));
    }, 300_000);

    afterAll(() => {
        for (const p of procs.splice(0)) p.kill();
        if (work) rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    });

    it('CONTROL: the NTS sibling of that zip reads as NOT thread-safe, so the check below can fail', async () => {
        const ntsDir = path.join(work, 'nts');
        mkdirSync(ntsDir, { recursive: true });
        const zip = path.join(work, 'php-nts.zip');
        const ntsUrls = assetFor(recipe, { os: 'win32', arch: 'x64' })!.urls.map((u) =>
            u.replace(`php-${recipe.version}-Win32-`, `php-${recipe.version}-nts-Win32-`),
        );
        expect(ntsUrls.every((u) => u.includes('-nts-'))).toBe(true);
        await download(ntsUrls, zip);
        const unpack = spawnSync(
            'powershell',
            ['-NoProfile', '-NonInteractive', '-Command', `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${ntsDir}' -Force`],
            { encoding: 'utf8' },
        );
        expect(unpack.status, unpack.stderr).toBe(0);
        expect(existsSync(path.join(ntsDir, phpThreadSafeDll(recipe.version)))).toBe(false);
        const v = spawnSync(path.join(ntsDir, 'php.exe'), ['--version'], { encoding: 'utf8' });
        expect(parsePhpThreadSafety(v.stdout)).toBe(false);
    }, 300_000);

    it('is a ZTS build: php8ts.dll ships, and php says so', () => {
        expect(existsSync(path.join(phpDir, phpThreadSafeDll(recipe.version)))).toBe(true);
        expect(existsSync(path.join(phpDir, 'php-cgi.exe'))).toBe(true);
        const v = spawnSync(path.join(phpDir, 'php.exe'), ['--version'], { encoding: 'utf8' });
        expect(v.status, v.stderr).toBe(0);
        expect(parsePhpThreadSafety(v.stdout)).toBe(true);
    });

    it("loads every extension Genie's php.ini names, with no loader warning", () => {
        const m = spawnSync(path.join(phpDir, 'php.exe'), ['-c', path.join(phpDir, 'php.ini'), '-m'], {
            encoding: 'utf8',
        });
        const loaded = parseModuleList(m.stdout, m.stderr);
        expect(loaded.warnings ?? '').toBe('');
        const names = new Set(loaded.modules.map((n) => n.toLowerCase()));
        expect(PHP_REQUIRED_MODULES.filter((e) => !names.has(e.toLowerCase()))).toEqual([]);
    });

    it('serves executed PHP through the bundled Caddy and the ZTS php-cgi', async () => {
        expect(existsSync(caddyBin), `the bundled Caddy must be built first (npm run build:runtime): ${caddyBin}`).toBe(true);
        const site = path.join(work, 'site');
        const root = path.join(site, 'public');
        mkdirSync(root, { recursive: true });
        const uploads = path.join(site, 'genie-uploads');
        mkdirSync(uploads);
        const marker = 'GENIE-REAL-ZTS-OK';
        writeFileSync(path.join(root, 'index.php'), `<?php echo "${marker} zts=".(PHP_ZTS ? 'yes' : 'no');`);

        const sitePort = await allocateFreePort();
        const fcgiPort = await allocateFreePort(new Set([sitePort]));
        const [wbin, ...wargs] = phpFastcgiWorkerCommand(path.join(phpDir, 'php-cgi.exe'), fcgiPort, uploads);
        procs.push(spawn(wbin!, wargs, { stdio: 'ignore' }));

        const configPath = path.join(site, 'Caddyfile');
        writeFileSync(configPath, serveCaddyfile({ sitePort, serve: { kind: 'php', root, fcgiPort } }));
        const [bin, ...args] = caddyServeArgv(caddyBin, configPath);
        procs.push(spawn(bin!, args, { stdio: 'ignore' }));

        expect(await waitForHttp(sitePort, 20_000), 'Caddy + the ZTS php-cgi must answer').toBe(true);
        const res = await fetch(`http://127.0.0.1:${sitePort}/`);
        expect(res.status).toBe(200);
        const body = await res.text();
        expect(body, 'PHP must have EXECUTED, not been served as source').not.toContain('<?php');
        expect(body).toContain(`${marker} zts=yes`);
    });
});
