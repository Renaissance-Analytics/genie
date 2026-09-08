import { afterEach, describe, expect, it } from 'vitest';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { serveCaddyfile, caddyServeArgv, phpFastcgiWorkerCommand } from '../serve-config';
import { allocateFreePort, waitForHttp } from '../port-probe';

/**
 * genie#539 — service env reaches the PHP *process* but must also reach the *app*.
 *
 * Genie composes the service env correctly and hands it to the FastCGI worker:
 * `site-manager.ts` builds it and starts the worker with it, and the real spawn is
 * `env: { ...process.env, ...spec.env }`. That much is not in doubt and is already
 * covered by unit tests. What no unit test can answer is the question the owner
 * actually asked — **can the application READ it?** — because that depends on
 * `variables_order`, an ini setting resolved inside the PHP process, by whichever
 * `php.ini` happened to win.
 *
 * That is why this lives in the real hosting lane (`npm run test:hosting`) next to
 * the #534 upload proof: only a real `php-cgi` answering a real request over real
 * Caddi can say what `$_ENV`, `$_SERVER` and `getenv()` actually contain.
 *
 * ## The configuration under test
 *
 * `PHPRC` pins a php.ini the test writes, so the result does not depend on the
 * runner's packaging. The pinned ini carries `variables_order = "GPCS"` — not a
 * contrived value: it is the line in PHP's own `php.ini-production` and
 * `php.ini-development`, so it is what Debian/Ubuntu's `php-cgi` package, Herd,
 * MAMP and every distro build ship. **`E` is missing from it, so `$_ENV` is never
 * populated from the process environment.** Genie's own generated `php.ini`
 * (`phpIniContents`) sets `variables_order` to nothing at all and inherits PHP's
 * compiled-in `EGPCS` — so today the answer is decided by luck, and Genie only
 * writes a php.ini on Windows in the first place.
 *
 * The fix is therefore to STATE it on the worker's command line, exactly as
 * genie#534 stated `upload_tmp_dir`: a define no ini can be missing.
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

/** The ABSOLUTE `php-cgi` on this machine, or '' — resolved, never assumed, because
 *  the worker command refuses a bare name (genie#207). */
const phpCgiExe = (() => {
    try {
        const which = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['php-cgi'], {
            encoding: 'utf8',
        });
        if (which.status !== 0) return '';
        const first = (which.stdout || '').split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? '';
        if (!first) return '';
        return spawnSync(first, ['--version'], { stdio: 'ignore' }).status === 0 ? first : '';
    } catch {
        return '';
    }
})();

/** One service value, named the way Genie actually injects them (`serviceEnv` emits
 *  `DB_PASSWORD` for the primary relational engine). */
const KEY = 'DB_PASSWORD';
const VALUE = 'genie-service-secret-539';

/** What the APP sees. Every surface a PHP config layer might read, reported
 *  separately so a partial rescue is visible rather than averaged away. */
function reportsEnv(root: string): void {
    writeFileSync(
        path.join(root, 'index.php'),
        `<?php
echo json_encode([
  // phpdotenv's EnvConstAdapter — Laravel's default, and what Symfony reads first.
  'env'    => $_ENV[${JSON.stringify(KEY)}]    ?? '(absent)',
  // phpdotenv's ServerConstAdapter.
  'server' => $_SERVER[${JSON.stringify(KEY)}] ?? '(absent)',
  // phpdotenv's PutenvAdapter.
  'getenv' => getenv(${JSON.stringify(KEY)}) === false ? '(absent)' : getenv(${JSON.stringify(KEY)}),
  'variables_order' => ini_get('variables_order'),
]);`,
    );
}

/** The php.ini every distro package, Herd and MAMP ship — PHP's own
 *  `php.ini-production` line, with `E` absent. */
function distroIni(dir: string): string {
    const ini = path.join(dir, 'php.ini');
    writeFileSync(ini, 'variables_order = "GPCS"\n');
    return ini;
}

/** Serve `root` over the real Caddy + a real php-cgi worker built by `buildWorker`,
 *  with `serviceEnv` in the WORKER's process environment (which is where Genie puts
 *  it), and return what PHP reported. */
async function askPhp(
    dir: string,
    root: string,
    buildWorker: (fcgiPort: number) => string[],
    workerEnv: NodeJS.ProcessEnv,
): Promise<Record<string, string>> {
    const sitePort = await allocateFreePort();
    const fcgiPort = await allocateFreePort(new Set([sitePort]));
    const [wbin, ...wargs] = buildWorker(fcgiPort);
    procs.push(spawn(wbin!, wargs, { stdio: 'ignore', env: workerEnv }));

    const configPath = path.join(dir, 'Caddyfile');
    writeFileSync(configPath, serveCaddyfile({ sitePort, serve: { kind: 'php', root, fcgiPort } }));
    const [bin, ...args] = caddyServeArgv(caddyBin, configPath);
    procs.push(spawn(bin!, args, { stdio: 'ignore' }));

    expect(await waitForHttp(sitePort, 15_000), 'Caddy + php-cgi must answer').toBe(true);
    const res = await fetch(`http://127.0.0.1:${sitePort}/`);
    expect(res.status).toBe(200);
    return JSON.parse(await res.text()) as Record<string, string>;
}

/** A fixture repo + the worker environment Genie composes for it. */
function fixture(label: string): { dir: string; root: string; env: NodeJS.ProcessEnv; ini: string } {
    const dir = mkdtempSync(path.join(tmpdir(), `genie-real-svcenv-${label}-`));
    dirs.push(dir);
    const root = path.join(dir, 'public');
    mkdirSync(root);
    reportsEnv(root);
    mkdirSync(path.join(dir, 'genie-uploads'), { recursive: true });
    const ini = distroIni(dir);
    // PHPRC pins WHICH php.ini this worker loads, so the measurement is about
    // Genie's configuration and not the runner's packaging. `[KEY]` is the service
    // env — set on the worker's PROCESS environment, exactly as hostSpawn does.
    return { dir, root, ini, env: { ...process.env, PHPRC: ini, [KEY]: VALUE } };
}

const uploadsIn = (dir: string) => path.join(dir, 'genie-uploads');

describe('REAL service env — a Genie-hosted PHP app can READ the values (genie#539)', () => {
    it.skipIf(!phpCgiExe)('the app reads a service value from $_ENV', async () => {
        // THE contract. `manageService` tells every agent that "an app served there
        // needs no `.env` edit"; this is the assertion that makes that sentence true
        // for the FastCGI path, on the surface Laravel and Symfony read FIRST.
        const { dir, root, env } = fixture('fixed');

        const seen = await askPhp(
            dir,
            root,
            (fcgiPort) => phpFastcgiWorkerCommand(phpCgiExe, fcgiPort, uploadsIn(dir)),
            env,
        );

        expect(seen.env, '$_ENV must carry the service value the worker was started with').toBe(
            VALUE,
        );
    });

    it.skipIf(!phpCgiExe)('POSITIVE CONTROL: the pre-fix worker command CANNOT (genie#539)', async () => {
        // Without this the test above is unfalsifiable — an env that arrived anyway
        // proves nothing about the define, and the harness itself (PHPRC reaching the
        // worker, the service var reaching its process environment) would be
        // untested. This runs the EXACT command Genie emitted before this fix —
        // php-cgi with the upload spool and a bind, and nothing about variables_order
        // — under the php.ini every distro ships, and pins the failure.
        const { dir, root, env } = fixture('control');

        const seen = await askPhp(
            dir,
            root,
            (fcgiPort) => [phpCgiExe, '-d', `upload_tmp_dir=${uploadsIn(dir)}`, '-b', `127.0.0.1:${fcgiPort}`],
            env,
        );

        // The reproduction, pinned: if a future change makes this pass, the
        // reproduction has stopped reproducing and the test above has stopped
        // meaning anything.
        expect(seen.variables_order, 'the control must run under the distro ini').toBe('GPCS');
        expect(seen.env, 'the pre-fix worker must NOT be able to show the app $_ENV').toBe(
            '(absent)',
        );
    });

    /**
     * MEASUREMENT, not a claim.
     *
     * genie#539 states two independent gaps — `variables_order` omitting `E`, and
     * Caddy forwarding only four CGI variables so "no service env reaches `$_SERVER`
     * per request". The second one has never been measured; PHP's CGI SAPI is
     * documented to consider the process environment "a part of the server
     * variables", which would make the Caddy half of the report wrong. `getenv()` is
     * likewise ASSUMED to work in the report ("getenv() should still work, which is
     * likely why this survived").
     *
     * Both are answerable only by a real worker, so this asks and pins the answer
     * rather than guessing. It runs BOTH configurations so the difference the fix
     * makes is visible on every surface, not just the one it targets.
     */
    it.skipIf(!phpCgiExe)('records what $_SERVER and getenv() do — before and after', async () => {
        const fixed = fixture('measure-fixed');
        const before = fixture('measure-before');

        const withFix = await askPhp(
            fixed.dir,
            fixed.root,
            (fcgiPort) => phpFastcgiWorkerCommand(phpCgiExe, fcgiPort, uploadsIn(fixed.dir)),
            fixed.env,
        );
        const withoutFix = await askPhp(
            before.dir,
            before.root,
            (fcgiPort) => [
                phpCgiExe,
                '-d',
                `upload_tmp_dir=${uploadsIn(before.dir)}`,
                '-b',
                `127.0.0.1:${fcgiPort}`,
            ],
            before.env,
        );

        // Printed so the CI log carries the evidence the issue is missing. The
        // assertions below pin it; this is what makes a change in the answer
        // readable rather than merely red.
        console.log('[genie#539] with the fix   :', JSON.stringify(withFix));
        console.log('[genie#539] without the fix:', JSON.stringify(withoutFix));

        // `getenv()` is the report's stated survivor — the reason a value works from
        // a terminal. It must hold in BOTH configurations, or the report's account of
        // why this went unnoticed is wrong.
        expect(withoutFix.getenv, 'getenv() is the rescue the report assumes').toBe(VALUE);
        expect(withFix.getenv).toBe(VALUE);

        // The fix must not COST any surface that already worked.
        for (const key of ['env', 'server', 'getenv'] as const) {
            if (withoutFix[key] === VALUE) {
                expect(withFix[key], `the fix must not lose $${key}`).toBe(VALUE);
            }
        }

        // And the surface the fix targets must move from absent to present — the
        // red→green transition, asserted as a DIFFERENCE so it cannot pass on a
        // configuration where the value was there all along.
        expect(withoutFix.env).toBe('(absent)');
        expect(withFix.env).toBe(VALUE);
    });
});
