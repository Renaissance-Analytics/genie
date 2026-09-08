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

    it('runs TWO sites AT ONCE, each serving its own app — the :2019 admin-port regression', async () => {
        // THE bug, reproduced deterministically. Each hostServe site spawns its own
        // Caddy, and Caddy's default admin endpoint binds 127.0.0.1:2019 — so the
        // SECOND concurrent Caddy died with "address already in use" and never came
        // up. Two AT ONCE is the only shape that reproduces it: a single site (or
        // sequential ones on a clean runner) binds :2019 alone and passes even unfixed.
        // With `admin off` neither touches :2019, so both serve — and each gets its
        // OWN app, not the other's (the moic.gen "wrong app" class of failure).
        const [portA, portB] = await Promise.all([
            serveStatic(true, 'GENIE-REAL-TWO-A'),
            serveStatic(true, 'GENIE-REAL-TWO-B'),
        ]);
        expect(portA).not.toBe(portB);
        const [a, b] = await Promise.all([
            fetch(`http://127.0.0.1:${portA}/`).then((r) => r.text()),
            fetch(`http://127.0.0.1:${portB}/`).then((r) => r.text()),
        ]);
        expect(a).toContain('GENIE-REAL-TWO-A');
        expect(a).not.toContain('GENIE-REAL-TWO-B');
        expect(b).toContain('GENIE-REAL-TWO-B');
        expect(b).not.toContain('GENIE-REAL-TWO-A');
    });
});

/**
 * The ABSOLUTE `php-cgi` on this machine, or '' when there is none.
 *
 * Resolved rather than assumed, because production spawns a resolved path now
 * (genie#207) — the worker command refuses a bare name outright. The CI hosting
 * job installs php-cgi; a bare dev box may not, so the php test is gated on this
 * rather than failing where PHP is simply absent.
 */
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

/** The Genie-owned upload spool for a real php run — created up front, exactly as
 *  the host's `prepareUploadTmpDir` seam does before it spawns the worker. */
function uploadDirIn(dir: string): string {
    const uploads = path.join(dir, 'genie-uploads');
    mkdirSync(uploads, { recursive: true });
    return uploads;
}

describe('REAL php serve mode — the bundled Caddy + php-cgi actually EXECUTE PHP', () => {
    it.skipIf(!phpCgiExe)('serves executed PHP from public/ over the FastCGI worker', async () => {
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
        const [wbin, ...wargs] = phpFastcgiWorkerCommand(phpCgiExe, fcgiPort, uploadDirIn(dir));
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

    it.skipIf(!phpCgiExe)('serves STATIC assets with a real Content-Type (genie#225)', async () => {
        // The gap that let #225 ship: the test above proves PHP executes, and stops
        // there. `php_fastcgi` does NOT include a file server — it rewrites to
        // index.php and proxies *.php, nothing else — so a request for a .js asset
        // matched no handler at all and Caddy answered 200 with an EMPTY body and
        // no Content-Type. The file was right there and readable.
        //
        // A missing type is not cosmetic for a modern app: Chrome enforces a JS
        // MIME type for <script type="module">, so every Vite/Inertia site served
        // this way rendered blank while its markup and props looked perfect.
        // hostServe php is the recommended path for a Laravel repo, so that is the
        // whole "host it the plain way" flow.
        const dir = mkdtempSync(path.join(tmpdir(), 'genie-real-php-assets-'));
        dirs.push(dir);
        const root = path.join(dir, 'public');
        mkdirSync(path.join(root, 'build', 'assets'), { recursive: true });
        writeFileSync(path.join(root, 'index.php'), '<?php echo "app";');
        writeFileSync(path.join(root, 'build', 'assets', 'app.js'), 'export const ok = 1;');
        writeFileSync(path.join(root, 'build', 'assets', 'app.css'), '.ok{color:red}');

        const sitePort = await allocateFreePort();
        const fcgiPort = await allocateFreePort(new Set([sitePort]));
        const [wbin, ...wargs] = phpFastcgiWorkerCommand(phpCgiExe, fcgiPort, uploadDirIn(dir));
        procs.push(spawn(wbin!, wargs, { stdio: 'ignore' }));

        const configPath = path.join(dir, 'Caddyfile');
        writeFileSync(configPath, serveCaddyfile({ sitePort, serve: { kind: 'php', root, fcgiPort } }));
        const [bin, ...args] = caddyServeArgv(caddyBin, configPath);
        procs.push(spawn(bin!, args, { stdio: 'ignore' }));

        expect(await waitForHttp(sitePort, 15_000), 'Caddy + php-cgi must answer').toBe(true);

        const js = await fetch(`http://127.0.0.1:${sitePort}/build/assets/app.js`);
        expect(js.status).toBe(200);
        expect(await js.text(), 'the asset must have a BODY, not an empty 200').toContain('export');
        // The assertion the browser itself makes: anything that is not a JS type
        // is a hard refusal for an ES module.
        expect(js.headers.get('content-type') ?? '').toMatch(/javascript|ecmascript/i);

        const css = await fetch(`http://127.0.0.1:${sitePort}/build/assets/app.css`);
        expect(css.status).toBe(200);
        // Dropped too under X-Content-Type-Options: nosniff, so fixing only the JS
        // case would leave the page unstyled instead of blank.
        expect(css.headers.get('content-type') ?? '').toMatch(/text[/]css/i);
    });

    /**
     * THE mixed-content bug, asserted where it actually lives: inside the PHP
     * process, on the variables a framework reads.
     *
     * The owner reported https/http mixed content on PHP sites while Node sites were
     * fine. The cause is this hop: a `.gen` is https at the front door, but this
     * per-site Caddy is plain http on loopback, so it derives the FastCGI `HTTPS`
     * param from its OWN connection (unset) and OVERWRITES the front door's
     * `X-Forwarded-Proto: https` with `http`. The app therefore concludes it is on
     * http and emits `http://<name>.gen` everywhere — including the two places no
     * response rewriter can reach: JSON-escaped `http:\/\/…` (PHP escapes slashes by
     * default) and anything its JavaScript builds at runtime. Node never hits this
     * because a Node dev server is ONE hop from the https front door.
     *
     * Asserting on the generated Caddyfile string is not enough — `env` and
     * `header_up` inside a `php_fastcgi` block either reach the FastCGI params or
     * they do not, and only the real binaries answer that. So this runs php-cgi and
     * reads back what PHP itself saw.
     */
    it.skipIf(!phpCgiExe)('tells PHP it is on https, so the app generates https URLs itself', async () => {
        const dir = mkdtempSync(path.join(tmpdir(), 'genie-real-php-https-'));
        dirs.push(dir);
        const root = path.join(dir, 'public');
        mkdirSync(root);
        // Exactly what Symfony\Component\HttpFoundation\Request::isSecure() reads —
        // the check every Laravel/Symfony URL, asset and redirect is built on.
        writeFileSync(
            path.join(root, 'index.php'),
            `<?php
$isSecure = !empty($_SERVER['HTTPS']) && strtolower($_SERVER['HTTPS']) !== 'off';
echo json_encode([
  'HTTPS' => $_SERVER['HTTPS'] ?? '(unset)',
  'SERVER_PORT' => $_SERVER['SERVER_PORT'] ?? '(unset)',
  'XFP' => $_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '(unset)',
  'isSecure' => $isSecure,
]);`,
        );

        const sitePort = await allocateFreePort();
        const fcgiPort = await allocateFreePort(new Set([sitePort]));
        const [wbin, ...wargs] = phpFastcgiWorkerCommand(phpCgiExe, fcgiPort, uploadDirIn(dir));
        procs.push(spawn(wbin!, wargs, { stdio: 'ignore' }));

        const configPath = path.join(dir, 'Caddyfile');
        writeFileSync(configPath, serveCaddyfile({ sitePort, serve: { kind: 'php', root, fcgiPort } }));
        const [bin, ...args] = caddyServeArgv(caddyBin, configPath);
        procs.push(spawn(bin!, args, { stdio: 'ignore' }));

        expect(await waitForHttp(sitePort, 15_000), 'Caddy + php-cgi must answer').toBe(true);
        const res = await fetch(`http://127.0.0.1:${sitePort}/`, { headers: { host: 'moic.gen' } });
        expect(res.status).toBe(200);
        const seen = JSON.parse(await res.text()) as Record<string, unknown>;

        // The one that decides every generated URL. Unfixed this is `(unset)`.
        expect(seen.HTTPS).toBe('on');
        expect(seen.isSecure, 'PHP must believe it is on https, or it emits http:// URLs').toBe(true);
        // Or the app builds `https://<name>.gen:<sitePort>` from the listener port.
        expect(String(seen.SERVER_PORT)).toBe('443');
        // The header this hop downgrades to `http` unless repaired — a proxy-TRUSTING
        // app reads this one instead, so it must not be left lying.
        expect(seen.XFP).toBe('https');
    });

    /**
     * THE upload bug (genie#534), asserted where it lives: inside the PHP process,
     * on a real multipart request over the real worker.
     *
     * `$_FILES` is filled by PHP's rfc1867 parser only AFTER it has spooled the body
     * to a temporary file. When that spool fails the request never reaches userland
     * intact — PHP writes "File upload error - unable to create a temporary file" at
     * REQUEST STARTUP and hands the script an entry with `UPLOAD_ERR_NO_TMP_DIR`, so
     * no route, middleware or exception handler in the app can report it and the UI
     * just shows a dead upload. Only a real POST through the real worker can tell
     * these apart, which is why this lives here and not in the unit suite.
     */
    function reportsUpload(root: string): void {
        // What the app sees. `err=0` + the round-tripped body is the only proof the
        // spool actually happened; an entry can exist with an error and no file.
        writeFileSync(
            path.join(root, 'upload.php'),
            `<?php
$f = $_FILES['f'] ?? null;
$ok = $f && (int) $f['error'] === UPLOAD_ERR_OK && is_uploaded_file($f['tmp_name']);
echo 'files=' . ($f ? 1 : 0)
   . ' err=' . ($f ? (int) $f['error'] : -1)
   . ' body=' . ($ok ? file_get_contents($f['tmp_name']) : '-');`,
        );
    }

    /** Start Caddy in front of the worker `buildWorker` names, POST a one-file
     *  multipart body to `upload.php`, and return what PHP reported about it. */
    async function postUpload(
        dir: string,
        root: string,
        buildWorker: (fcgiPort: number) => string[],
        workerEnv: NodeJS.ProcessEnv,
        marker: string,
    ): Promise<string> {
        const sitePort = await allocateFreePort();
        const fcgiPort = await allocateFreePort(new Set([sitePort]));
        const [wbin, ...wargs] = buildWorker(fcgiPort);
        procs.push(spawn(wbin!, wargs, { stdio: 'ignore', env: workerEnv }));

        const configPath = path.join(dir, 'Caddyfile');
        writeFileSync(configPath, serveCaddyfile({ sitePort, serve: { kind: 'php', root, fcgiPort } }));
        const [bin, ...args] = caddyServeArgv(caddyBin, configPath);
        procs.push(spawn(bin!, args, { stdio: 'ignore' }));
        expect(await waitForHttp(sitePort, 15_000), 'Caddy + php-cgi must answer').toBe(true);

        const form = new FormData();
        form.append('f', new Blob([marker], { type: 'text/plain' }), 'note.txt');
        const res = await fetch(`http://127.0.0.1:${sitePort}/upload.php`, { method: 'POST', body: form });
        expect(res.status).toBe(200);
        return await res.text();
    }

    /**
     * The reported condition, reproduced: the worker inherits a temp directory it
     * cannot use. That is not contrived — the worker is spawned with
     * `{ ...process.env }`, so it gets whatever temp directory GENIE'S process had,
     * which is not necessarily one the serving identity can write. On unix PHP takes
     * `TMPDIR` verbatim with no writability check, so pointing it at a path that does
     * not exist is exactly the state the reporter's machine was in.
     */
    const brokenTempEnv = (dir: string): NodeJS.ProcessEnv => {
        const gone = path.join(dir, 'no-such-temp-dir');
        return { ...process.env, TMPDIR: gone, TMP: gone, TEMP: gone };
    };

    it.skipIf(!phpCgiExe)('accepts a real multipart UPLOAD — the worker is TOLD where to spool (genie#534)', async () => {
        const dir = mkdtempSync(path.join(tmpdir(), 'genie-real-php-upload-'));
        dirs.push(dir);
        const root = path.join(dir, 'public');
        mkdirSync(root);
        reportsUpload(root);

        const marker = 'GENIE-REAL-UPLOAD-OK';
        const uploads = uploadDirIn(dir);
        const body = await postUpload(
            dir,
            root,
            (fcgiPort) => phpFastcgiWorkerCommand(phpCgiExe, fcgiPort, uploads),
            // Broken inherited temp dir AND a stated upload dir: the whole point is
            // that the stated one wins, so the site serves uploads on a machine whose
            // ambient temp directory Genie does not control.
            brokenTempEnv(dir),
            marker,
        );

        expect(body).toContain('err=0');
        expect(body, 'PHP must have SPOOLED the file, not just seen the field').toContain(
            `body=${marker}`,
        );
    });

    it.skipIf(!phpCgiExe)('POSITIVE CONTROL: the pre-fix command line FAILS the same upload', async () => {
        // Without this the test above is unfalsifiable — an upload that would have
        // worked anyway proves nothing about `upload_tmp_dir`, and the harness itself
        // (Caddy's body forwarding, the multipart encoding, the poisoned env actually
        // reaching the worker) would be untested.
        //
        // This runs the EXACT command Genie emitted before genie#534 — php-cgi with a
        // bind and nothing else — against the same broken inherited temp dir, and
        // pins the failure: UPLOAD_ERR_NO_TMP_DIR (6), the userland face of "File
        // upload error - unable to create a temporary file". If a future change makes
        // this pass, the reproduction has stopped reproducing and the green test
        // above has stopped meaning anything.
        const dir = mkdtempSync(path.join(tmpdir(), 'genie-real-php-noupload-'));
        dirs.push(dir);
        const root = path.join(dir, 'public');
        mkdirSync(root);
        reportsUpload(root);

        const body = await postUpload(
            dir,
            root,
            (fcgiPort) => [phpCgiExe, '-b', `127.0.0.1:${fcgiPort}`],
            brokenTempEnv(dir),
            'GENIE-REAL-UPLOAD-CONTROL',
        );

        expect(body, 'the pre-fix worker must NOT be able to spool an upload').not.toContain('err=0');
        expect(body).toContain(`err=${6}`); // UPLOAD_ERR_NO_TMP_DIR
        expect(body).toContain('body=-');
    });
});
