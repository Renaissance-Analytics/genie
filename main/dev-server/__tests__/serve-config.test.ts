import { describe, expect, it } from 'vitest';
import { serveCaddyfile, phpFastcgiWorkerCommand, caddyServeArgv } from '../serve-config';

/**
 * Genie owns the web-server config so an AGENT never writes one (the owner's
 * screenshot: an agent hand-rolling `printf "server { … try_files … }" > default.conf;
 * exec nginx`). An agent declares a SERVE MODE and Genie renders the Caddyfile:
 *   - `static` — serve a built directory, with SPA fallback to index.html;
 *   - `php`    — serve `public/` and hand PHP to a FastCGI worker.
 * Every mode is a plain-http listener on a loopback port; the `.gen` front door
 * adds TLS, so this is `auto_https off`. Reverse-proxy (a repo's own dev server /
 * a service) is the OTHER path and needs no generated config at all.
 */
describe('serveCaddyfile — static', () => {
    it('serves a built directory over file_server (no SPA fallback when spa=false)', () => {
        const cf = serveCaddyfile({
            sitePort: 5321,
            serve: { kind: 'static', root: '/repos/imp-wallet/dist', spa: false },
        });
        expect(cf).toContain(':5321 {');
        expect(cf).toContain('root * "/repos/imp-wallet/dist"');
        expect(cf).toContain('file_server');
        expect(cf).not.toContain('try_files');
        expect(cf).toContain('auto_https off');
    });

    it('falls back to index.html for an SPA so client-side routes resolve', () => {
        const cf = serveCaddyfile({
            sitePort: 5321,
            serve: { kind: 'static', root: '/repos/imp-ledger/dashboard/dist', spa: true },
        });
        // The exact thing the agent hand-rolled: unmatched path -> index.html.
        expect(cf).toContain('try_files {path} /index.html');
        expect(cf).toContain('file_server');
    });

    it('normalises a Windows root and refuses an injectable one', () => {
        expect(
            serveCaddyfile({ sitePort: 1, serve: { kind: 'static', root: 'C:\\r\\dist', spa: false } }),
        ).toContain('root * "C:/r/dist"');
        expect(() =>
            serveCaddyfile({ sitePort: 1, serve: { kind: 'static', root: 'a"\n}', spa: false } }),
        ).toThrow();
    });

    it('disables the admin API + shared autosave so MANY per-site Caddys coexist', () => {
        // Each hostServe site spawns its OWN Caddy. Caddy's admin endpoint binds
        // 127.0.0.1:2019 by DEFAULT, so a SECOND site's Caddy died with "listen tcp
        // 127.0.0.1:2019: bind: address already in use" and never started — two
        // static/php sites could not run at once (caught by serve-config.real.test.ts,
        // invisible to the mocked hosting E2E). These Caddys are driven by hostSpawn,
        // never Caddy's API, so the API is off and there is no shared autosave to race.
        const cf = serveCaddyfile({ sitePort: 5321, serve: { kind: 'static', root: 'dist', spa: false } });
        expect(cf).toContain('admin off');
        expect(cf).toContain('persist_config off');
    });
});

describe('serveCaddyfile — php', () => {
    it('serves public/ and routes PHP to the FastCGI worker (plain http)', () => {
        const cf = serveCaddyfile({
            sitePort: 5321,
            serve: { kind: 'php', root: '/repos/moic/public', fcgiPort: 5322 },
        });
        expect(cf).toContain('root * "/repos/moic/public"');
        expect(cf).toContain('php_fastcgi 127.0.0.1:5322');
        expect(cf).toContain('auto_https off');
        // MUST have a file server, and this assertion used to say the opposite —
        // "php_fastcgi adds its own file server", which is not true and is what
        // locked in genie#225. php_fastcgi is the front controller: it rewrites an
        // unmatched path to index.php and proxies *.php, and serves nothing else.
        // Without file_server a request for /build/assets/app.js matched no
        // handler and Caddy returned 200 with an empty body and no Content-Type,
        // so every Vite/Inertia site hosted this way rendered blank.
        expect(cf).toContain('file_server');
        // ORDER matters: the front controller has to get first refusal, otherwise
        // a bare file server would answer paths index.php is meant to own.
        expect(cf.indexOf('php_fastcgi')).toBeLessThan(cf.indexOf('file_server'));
    });

    /**
     * WHY a plain-http listener has to LIE to PHP about its own scheme.
     *
     * A `.gen` is https at the front door, but this per-site Caddy is deliberately
     * plain http on loopback — so Caddy sets the FastCGI `HTTPS` param from ITS OWN
     * connection and leaves it unset. Every PHP framework decides `isSecure()` from
     * exactly that (`Symfony\Component\HttpFoundation\Request::isSecure()` reads
     * `$_SERVER['HTTPS']`), so the app concludes it is on http and generates
     * `http://<name>.gen` for every asset, route and redirect it emits.
     *
     * MEASURED behind the shipped config — `php-cgi` reported:
     *   HTTPS=(unset)  SERVER_PORT=80  HTTP_X_FORWARDED_PROTO=http
     *
     * The last one is the sharp edge: this Caddy is a second proxy hop, so it
     * OVERWRITES the front door's `X-Forwarded-Proto: https` with its own scheme.
     * An app that dutifully trusts the proxy is therefore told `http` — the standard
     * remedy is not merely absent, it is actively defeated. That is the whole
     * Node-vs-PHP asymmetry: a Node dev server sits ONE hop from the https front
     * door and sees `X-Forwarded-Proto: https`; only the PHP path has this hop.
     *
     * Genie hosts third-party PHP apps and cannot edit their source, so it tells
     * the runtime the truth from OUTSIDE instead: `HTTPS=on` makes `isSecure()` true
     * with no framework config at all, and the app then emits https natively — in
     * the body, in `Location`, in the `Link` preload header, and in JSON-escaped
     * `http:\/\/` strings no response rewriter can ever reach.
     */
    it('tells PHP it is behind https, so the app generates https URLs at the source', () => {
        const cf = serveCaddyfile({
            sitePort: 5321,
            serve: { kind: 'php', root: '/repos/moic/public', fcgiPort: 5322 },
        });
        // What every PHP framework actually reads.
        expect(cf).toContain('env HTTPS on');
        // Otherwise the app builds `https://<name>.gen:5321` from the listener port.
        expect(cf).toContain('env SERVER_PORT 443');
        // Repair the header this hop would otherwise downgrade to `http`.
        expect(cf).toContain('header_up X-Forwarded-Proto https');
    });

    it('does NOT claim https for a static site — it executes nothing that could ask', () => {
        const cf = serveCaddyfile({
            sitePort: 5321,
            serve: { kind: 'static', root: '/repos/orr/dist', spa: true },
        });
        expect(cf).not.toContain('env HTTPS on');
    });
});

describe('phpFastcgiWorkerCommand', () => {
    const EXE = 'C:\\gd\\toolchain\\php\\8.3.33\\php-cgi.exe';
    const UPLOADS = 'C:\\gd\\host-site-uploads\\a1b2c3';

    it('runs the RESOLVED php-cgi as a FastCGI server bound to the worker port', () => {
        // The executable comes from the site's toolchain resolution (genie#207) —
        // an absolute path inside the install Genie owns, so the worker is THE php
        // the site names rather than whatever PATH answers today.
        //
        // The WHOLE array is pinned deliberately. "the command mentions
        // upload_tmp_dir" would also pass against a builder that emitted nonsense
        // around it; this says the invocation is still EXACTLY a php-cgi FastCGI
        // bind, with the ini defines added and nothing else disturbed.
        expect(phpFastcgiWorkerCommand(EXE, 5322, UPLOADS)).toEqual([
            EXE,
            '-d',
            'upload_tmp_dir=C:\\gd\\host-site-uploads\\a1b2c3',
            '-d',
            'variables_order=EGPCS',
            '-b',
            '127.0.0.1:5322',
        ]);
    });

    it('states `variables_order` so the APP can read the service env (genie#539)', () => {
        // Genie composes the service env and starts the worker with it — that half
        // was never in doubt. What decides whether the APP can READ it is
        // `variables_order`, and Genie stated nothing: the answer came from whichever
        // php.ini happened to win. PHP's own `php.ini-production` and
        // `php.ini-development` both say `GPCS` — no `E` — so on a distro package,
        // Herd or MAMP `$_ENV` is never populated from the process environment, and
        // `$_ENV` is the surface Laravel's phpdotenv and Symfony read FIRST. Genie's
        // own generated ini sets the key to nothing at all and rides on PHP's
        // compiled-in `EGPCS`, and Genie writes a php.ini on Windows only.
        //
        // So it is STATED here, for the reason `upload_tmp_dir` is (genie#534): a
        // define on the command line cannot be missing from an ini Genie does not
        // own, and cannot be lost when someone else's ini wins.
        const cmd = phpFastcgiWorkerCommand(EXE, 5322, UPLOADS);
        const at = cmd.indexOf('variables_order=EGPCS');
        expect(at, 'the define must be present').toBeGreaterThan(0);
        expect(cmd[at - 1], 'and be passed as an ini define').toBe('-d');
    });

    it('gives the worker an EXPLICIT upload_tmp_dir — an INHERITED one is genie#534', () => {
        // Every multipart upload to a Genie-hosted PHP site died with
        //   PHP Request Startup: File upload error - unable to create a temporary file
        // BEFORE Laravel saw the request, so no route, middleware or exception
        // handler could report it — from the UI it was simply a dead upload.
        //
        // The worker inherits `{ ...process.env }`, so with `upload_tmp_dir` unset
        // PHP fell back to whatever temp directory GENIE'S OWN process happened to
        // have: a directory the serving identity may not be able to write, or which
        // may not exist at all. Genie writes the Caddyfile and spawns this worker,
        // so uploads working is part of serving PHP — the directory is STATED here,
        // never inherited.
        const cmd = phpFastcgiWorkerCommand(EXE, 5322, UPLOADS);
        const d = cmd.indexOf('-d');
        expect(d).toBeGreaterThan(0);
        expect(cmd[d + 1]).toBe(`upload_tmp_dir=${UPLOADS}`);
    });

    it('REFUSES a bare binary name — that PATH lookup is genie#206 itself', () => {
        // On the reporting machine PATH held only Herd's `php.bat` shim, so a bare
        // `php-cgi` started cmd.exe, printed "not recognized", and exited — with a
        // pid, so the start looked fine. Nothing may reintroduce it by accident.
        expect(() => phpFastcgiWorkerCommand('php-cgi', 5322, UPLOADS)).toThrow(/bare/i);
        // The MESSAGE, not merely "it threw": an absent executable and a bare one are
        // different mistakes with different fixes, and an assertion that accepts
        // either lets one of the two guards rot into a no-op unnoticed (a bare `''`
        // trips the separator check too, so "it throws" proves nothing about which).
        expect(() => phpFastcgiWorkerCommand('', 5322, UPLOADS)).toThrow(/missing php-cgi/i);
    });

    it('REFUSES an upload dir that is missing, bare, or would break the ini define', () => {
        // The same reasoning as the executable, one layer down. A BARE `uploads` is
        // resolved by PHP against the WORKER'S cwd — the user's repo — so it would
        // either litter their checkout or silently not exist, which is genie#534
        // again under a different name. A quote or a newline in the value would end
        // the `-d` define early, and on win32 this argv is re-joined into a cmd.exe
        // command line, so neither may reach it.
        expect(() => phpFastcgiWorkerCommand(EXE, 5322, '')).toThrow(/missing upload_tmp_dir/i);
        expect(() => phpFastcgiWorkerCommand(EXE, 5322, 'uploads')).toThrow(/bare upload_tmp_dir/i);
        expect(() => phpFastcgiWorkerCommand(EXE, 5322, '/tmp/a"b')).toThrow(/injectable/i);
        expect(() => phpFastcgiWorkerCommand(EXE, 5322, '/tmp/a\nb')).toThrow(/injectable/i);
    });
});

describe('caddyServeArgv', () => {
    it('runs Genie\u2019s bundled Caddy in the FOREGROUND against a per-site config', () => {
        // Foreground `run` (not `start`): this Caddy IS the host process Genie tracks
        // for the site, so hostSpawn owns its lifecycle like any other dev server.
        expect(caddyServeArgv('/opt/genie/caddy', '/cfg/web.caddyfile')).toEqual([
            '/opt/genie/caddy',
            'run',
            '--config',
            '/cfg/web.caddyfile',
            '--adapter',
            'caddyfile',
        ]);
    });
});
