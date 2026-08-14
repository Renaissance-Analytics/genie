import { describe, expect, it } from 'vitest';
import {
    effectiveCommand,
    portableArgv,
    sandboxCommandFor,
    sanitizeDevSitePatch,
    withoutPersistedEnv,
    devSiteReconfigureNeedsRestart,
    hostNativeRoute,
    siteEngineUse,
    type DevSiteConfig,
} from '../sites-config';

/**
 * The user-controlled `command` — the heart of the sandbox-serve model. It is the
 * canonical startup argv; `serve` remains a read-only fallback for sites saved
 * before the rework so they keep running until re-saved.
 */
const base = (over: Partial<DevSiteConfig> = {}): DevSiteConfig => ({
    name: 'web',
    genName: 'web.acme.gen',
    repo: 'app',
    runMode: 'explicit',
    kind: 'http',
    enabled: true,
    ...over,
});

describe('site config — user-controlled command', () => {
    it('keeps a valid command argv and rejects a shell string (no injection)', () => {
        const clean = sanitizeDevSitePatch({
            ...base(),
            command: ['npm', 'run', 'dev'],
        } as DevSiteConfig);
        expect(clean.command).toEqual(['npm', 'run', 'dev']);

        const shelly = sanitizeDevSitePatch({
            ...base(),
            command: 'npm run dev && rm -rf /' as unknown as string[],
        } as DevSiteConfig);
        expect(shelly.command).toBeUndefined(); // not an argv array → dropped
    });

    it('effectiveCommand prefers command, falls back to legacy serve, else null', () => {
        expect(effectiveCommand(base({ command: ['a', 'b'], serve: ['old'] }))).toEqual(['a', 'b']);
        expect(effectiveCommand(base({ serve: ['php', 'artisan', 'serve'] }))).toEqual([
            'php',
            'artisan',
            'serve',
        ]);
        expect(effectiveCommand(base({}))).toBeNull();
        expect(effectiveCommand(base({ command: [] }))).toBeNull(); // empty ⇒ nothing to run
    });

    it('migrates a legacy FrankenPHP recipe to `php artisan serve` in the sandbox', () => {
        // The exact serve the old PHP recipe stored (see the user's live sites).
        const cfg = base({
            server: 'frankenphp',
            stack: 'php',
            port: 8080,
            serve: ['frankenphp', 'php-server', '--listen', '0.0.0.0:8080', '--root', 'public/'],
        });
        expect(sandboxCommandFor(cfg)).toEqual([
            'php',
            'artisan',
            'serve',
            '--host=0.0.0.0',
            '--port=8080',
        ]);
    });

    it('does NOT rewrite `frankenphp run --config` — a real command, not the legacy php-server recipe (#141)', () => {
        // The over-broad `has("frankenphp")` used to catch this and rewrite it to
        // `php artisan serve`, so a site serving a custom Caddyfile (e.g. a Reverb
        // /app proxy) silently ran the wrong server. Only the legacy php-server SHAPE
        // is a recipe; `frankenphp run` is the user's own command and passes through.
        const cfg = base({
            server: 'frankenphp',
            stack: 'php',
            port: 8080,
            serve: ['frankenphp', 'run', '--config', 'Caddyfile'],
        });
        expect(sandboxCommandFor(cfg)).toEqual(['frankenphp', 'run', '--config', 'Caddyfile']);
    });

    it('STILL migrates a legacy php-server recipe even with a custom image (image is runtime-ignored)', () => {
        // A custom `image` is build metadata; the site still runs in the workspace
        // sandbox (which lacks frankenphp), so the legacy php-server recipe must be
        // migrated to `php artisan serve` regardless of the image. (See
        // site-manager.test.ts "routes a custom-image + explicit-serve site through
        // the sandbox".)
        const cfg = base({
            server: 'frankenphp',
            stack: 'php',
            port: 8080,
            image: 'dunglas/frankenphp:1-php8.4',
            serve: ['frankenphp', 'php-server', '--listen', '0.0.0.0:8080', '--root', 'public/'],
        });
        expect(sandboxCommandFor(cfg)).toEqual(['php', 'artisan', 'serve', '--host=0.0.0.0', '--port=8080']);
    });

    it('migrates a legacy nginx static recipe to PHP\'s built-in server over the docroot', () => {
        // docroot from the GENIE_NGINX_ROOT env the recipe set…
        const fromEnv = base({
            port: 3000,
            env: { GENIE_NGINX_ROOT: 'dist' },
            serve: ['sh', '-c', 'printf "...root %s/%s..."; exec nginx -g "daemon off;"'],
        });
        expect(sandboxCommandFor(fromEnv)).toEqual(['php', '-S', '0.0.0.0:3000', '-t', 'dist']);

        // …or parsed from an inlined `root $PWD/<docroot>` (the karma case).
        const inlined = base({
            port: 3000,
            command: [
                'sh',
                '-c',
                "set -e; printf 'server { listen 3000; root %s/dashboard/dist; index index.html; }' \"$PWD\" > /etc/nginx/conf.d/default.conf; exec nginx -g 'daemon off;'",
            ],
        });
        expect(sandboxCommandFor(inlined)).toEqual([
            'php',
            '-S',
            '0.0.0.0:3000',
            '-t',
            'dashboard/dist',
        ]);
    });

    it('leaves a real user command UNTOUCHED — a chosen command is never rewritten', () => {
        expect(sandboxCommandFor(base({ command: ['npm', 'run', 'dev'], port: 5173 }))).toEqual([
            'npm',
            'run',
            'dev',
        ]);
        expect(sandboxCommandFor(base({ serve: ['./bin/server'], port: 8000 }))).toEqual([
            './bin/server',
        ]);
        expect(sandboxCommandFor(base({}))).toBeNull();
    });

    it('a command change is a restart-worthy reconfigure', () => {
        const before = base({ command: ['npm', 'run', 'dev'] });
        const after = base({ command: ['npm', 'run', 'start'] });
        expect(devSiteReconfigureNeedsRestart(before, after)).toBe(true);
        expect(devSiteReconfigureNeedsRestart(before, base({ command: ['npm', 'run', 'dev'] }))).toBe(
            false,
        );
    });
});

describe('machine-specific binary paths are NEVER persisted to project.json (genie #199)', () => {
    it('rewrites an ABSOLUTE toolchain-binary path to its bare, PATH-resolved name', () => {
        // The exact Herd case from the bug: Herd exposes `php` as a .bat shim that
        // can't be spawned, so the real php84\php.exe absolute path leaks into the
        // stored command — and project.json is the COMMITTED, cloned envelope.
        expect(
            portableArgv(['C:\\Users\\glenn\\.config\\herd\\bin\\php84\\php.exe', 'artisan', 'serve']),
        ).toEqual(['php', 'artisan', 'serve']);
        // Unix absolute path too.
        expect(portableArgv(['/opt/homebrew/bin/php', '-S', '127.0.0.1:8000'])).toEqual([
            'php',
            '-S',
            '127.0.0.1:8000',
        ]);
        // Executable extension + case are dropped.
        expect(portableArgv(['C:\\tools\\node\\NODE.EXE', 'server.js'])).toEqual(['node', 'server.js']);
        expect(portableArgv(['C:\\x\\composer.bat', 'install'])).toEqual(['composer', 'install']);
    });

    it('leaves portable commands ALONE — a bare name, or a repo-relative script', () => {
        expect(portableArgv(['php', 'artisan', 'serve'])).toEqual(['php', 'artisan', 'serve']);
        expect(portableArgv(['npm', 'run', 'dev'])).toEqual(['npm', 'run', 'dev']);
        // A repo-local script is already portable across clones — don't bare it.
        expect(portableArgv(['./vendor/bin/pest'])).toEqual(['./vendor/bin/pest']);
        expect(portableArgv([])).toEqual([]);
    });

    it('leaves an absolute path to an UNKNOWN binary as-is — baring it could point at nothing', () => {
        // Not a known toolchain bin, so we can't assume the bare name resolves on
        // PATH; a wrong-but-visible path beats a silently-broken bare name.
        expect(portableArgv(['C:\\custom\\mytool.exe', 'go'])).toEqual(['C:\\custom\\mytool.exe', 'go']);
    });

    it('normalizes command, serve, AND build steps at the write boundary', () => {
        const clean = sanitizeDevSitePatch({
            ...base(),
            command: ['C:\\Users\\glenn\\.config\\herd\\bin\\php84\\php.exe', 'artisan', 'serve'],
            serve: ['/usr/local/bin/php', 'artisan', 'serve'],
            build: [{ label: 'assets', command: ['C:\\tools\\node\\node.exe', 'build.js'] }],
        } as DevSiteConfig);
        expect(clean.command).toEqual(['php', 'artisan', 'serve']);
        expect(clean.serve).toEqual(['php', 'artisan', 'serve']);
        expect(clean.build?.[0]?.command).toEqual(['node', 'build.js']);
    });
});

describe('host-native site (story #238) — point .gen at a host dev-server port, no container', () => {
    it('sanitize accepts a valid hostPort and drops an out-of-range/non-integer one', () => {
        expect(sanitizeDevSitePatch({ ...base(), hostPort: 8001 }).hostPort).toBe(8001);
        expect(sanitizeDevSitePatch({ ...base(), hostPort: 0 }).hostPort).toBeUndefined();
        expect(sanitizeDevSitePatch({ ...base(), hostPort: 70000 }).hostPort).toBeUndefined();
        expect(sanitizeDevSitePatch({ ...base(), hostPort: 1.5 as unknown as number }).hostPort).toBeUndefined();
    });

    it('hostNativeRoute points .gen straight at 127.0.0.1:<hostPort> over plain http', () => {
        expect(hostNativeRoute(base({ genName: 'moic.gen', hostPort: 8001 }))).toEqual({
            genName: 'moic.gen',
            scheme: 'http',
            loopback: '127.0.0.1',
            port: 8001,
        });
    });

    it('carries an upstreamHost override when pinned', () => {
        expect(
            hostNativeRoute(base({ genName: 'moic.gen', hostPort: 8001, upstreamHost: 'localhost' })),
        ).toMatchObject({ upstreamHost: 'localhost' });
    });

    it('is null for an ordinary container site (no hostPort) or a non-http site', () => {
        expect(hostNativeRoute(base({ command: ['npm', 'run', 'dev'], port: 5173 }))).toBeNull();
        expect(hostNativeRoute(base({ hostPort: 8001, kind: 'tcp' }))).toBeNull();
    });

    it('a hostPort change needs a restart (routing identity)', () => {
        expect(devSiteReconfigureNeedsRestart(base({ hostPort: 8001 }), base({ hostPort: 8002 }))).toBe(true);
        expect(devSiteReconfigureNeedsRestart(base({ hostPort: 8001 }), base({ hostPort: 8001 }))).toBe(false);
    });
});

describe('site env is NEVER persisted to the tracked manifest (genie #168 — secrets out of project.json)', () => {
    it('drops `env` from the sanitized (persisted) patch — even non-secret values', () => {
        // project.json is tracked + committed + pushed; a secret in sites.<id>.env
        // (e.g. Laravel APP_KEY) leaks. The manifest carries STACK META only — env
        // lives in the repo .env (per-dev, gitignored), which the app reads.
        const clean = sanitizeDevSitePatch({
            ...base(),
            env: { APP_KEY: 'base64:supersecret', NODE_ENV: 'production' },
        });
        expect(clean.env).toBeUndefined();
    });

    it('withoutPersistedEnv strips env from EVERY site — the write-boundary scrub that beats the merge', () => {
        // sanitizeDevSitePatch drops env from a fresh patch, but a write merges the
        // patch OVER the stored row, so a row that already holds env (a pre-fix leak,
        // or a patch that did not touch env) would keep it. The write-boundary
        // transform scrubs it regardless.
        const sites = {
            a: { ...base(), env: { APP_KEY: 'base64:leaked' } },
            b: { ...base({ name: 'b', genName: 'b.acme.gen' }) },
        };
        const clean = withoutPersistedEnv(sites);
        expect(clean.a?.env).toBeUndefined();
        expect(clean.b?.env).toBeUndefined();
        // Everything else survives — only env is removed.
        expect(clean.a?.genName).toBe('web.acme.gen');
        expect(clean.b?.name).toBe('b');
    });

    it('keeps the stack meta a workspace needs to set the site up on another machine', () => {
        const clean = sanitizeDevSitePatch({
            ...base({ repo: 'app', runMode: 'host', stack: 'php', port: 8080 }),
            hostServe: { mode: 'static', root: 'dist' },
            env: { SECRET: 'x' },
        });
        // The recipe survives (portable across devs); only env is stripped.
        expect(clean.repo).toBe('app');
        expect(clean.runMode).toBe('host');
        expect(clean.hostServe).toEqual({ mode: 'static', root: 'dist' });
        expect(clean.env).toBeUndefined();
    });
});

describe('host-native serve mode — Genie serves it, the agent writes no config', () => {
    it('accepts a static serve with an in-repo root, keeping the SPA flag only when set', () => {
        expect(sanitizeDevSitePatch({ ...base(), hostServe: { mode: 'static', root: 'dist', spa: true } }).hostServe).toEqual({
            mode: 'static',
            root: 'dist',
            spa: true,
        });
        // spa omitted ⇒ not stored (plain static, no index.html fallback).
        expect(
            sanitizeDevSitePatch({ ...base(), hostServe: { mode: 'static', root: 'dashboard/dist' } }).hostServe,
        ).toEqual({ mode: 'static', root: 'dashboard/dist' });
    });

    it('accepts a php serve rooted at public/', () => {
        expect(sanitizeDevSitePatch({ ...base(), hostServe: { mode: 'php', root: 'public' } }).hostServe).toEqual({
            mode: 'php',
            root: 'public',
        });
    });

    it('keeps a PINNED php version, and stores nothing when the site follows the default', () => {
        // A pin is what makes "this app needs 8.3" survive somebody flipping the
        // machine default (genie#207). Absent ⇒ the site FOLLOWS the default, which
        // is a different state from "pinned to today's default" and must not be
        // silently upgraded into one.
        expect(
            sanitizeDevSitePatch({ ...base(), hostServe: { mode: 'php', root: 'public', version: '8.3' } })
                .hostServe,
        ).toEqual({ mode: 'php', root: 'public', version: '8.3' });
        expect(
            sanitizeDevSitePatch({ ...base(), hostServe: { mode: 'php', root: 'public', version: '' } })
                .hostServe,
        ).toEqual({ mode: 'php', root: 'public' });
    });

    it('drops a version that is not one — it is matched against installs, not trusted', () => {
        for (const version of ['8.3; rm -rf /', 'latest', '../../etc', 'v8.3', '8.3.33.7.2']) {
            expect(
                sanitizeDevSitePatch({
                    ...base(),
                    hostServe: { mode: 'php', root: 'public', version } as never,
                }).hostServe,
            ).toEqual({ mode: 'php', root: 'public' });
        }
    });

    it('reports which ENGINE a site uses, and whether it PINS one', () => {
        // Feeds the Toolchain page's "used by" line and the default-change notice.
        // A Genie-SERVED php site runs php whatever its detected `stack` says — the
        // serve mode is the fact, the stack is a guess — and a PINNED site must not
        // be counted among the ones a default change moves.
        expect(siteEngineUse({ genName: 'a.gen', hostServe: { mode: 'php', root: 'public' } })).toEqual(
            { genName: 'a.gen', tool: 'php' },
        );
        expect(
            siteEngineUse({
                genName: 'b.gen',
                stack: 'static',
                hostServe: { mode: 'php', root: 'public', version: '8.3' },
            }),
        ).toEqual({ genName: 'b.gen', tool: 'php', version: '8.3' });
        // A repo running its OWN dev server still consumes its stack's engine.
        expect(siteEngineUse({ genName: 'c.gen', stack: 'node' })).toEqual({
            genName: 'c.gen',
            tool: 'node',
        });
        // A static site runs no engine, so a default change does not move it.
        expect(siteEngineUse({ genName: 'd.gen', stack: 'static' })).toBeNull();
        expect(
            siteEngineUse({ genName: 'e.gen', hostServe: { mode: 'static', root: 'dist' } }),
        ).toBeNull();
        expect(siteEngineUse({ genName: 'f.gen' })).toBeNull();
    });

    it('a version change needs a restart — the running worker is the OLD php', () => {
        expect(
            devSiteReconfigureNeedsRestart(
                base({ hostServe: { mode: 'php', root: 'public', version: '8.3' } }),
                base({ hostServe: { mode: 'php', root: 'public', version: '8.4' } }),
            ),
        ).toBe(true);
    });

    it('normalises Windows separators and a trailing slash', () => {
        expect(
            sanitizeDevSitePatch({ ...base(), hostServe: { mode: 'static', root: 'dashboard\\dist\\' } }).hostServe,
        ).toEqual({ mode: 'static', root: 'dashboard/dist' });
    });

    it('rejects an unknown mode, an absolute root, or one that climbs out of the repo', () => {
        expect(
            sanitizeDevSitePatch({ ...base(), hostServe: { mode: 'nginx', root: 'dist' } as never }).hostServe,
        ).toBeUndefined();
        expect(
            sanitizeDevSitePatch({ ...base(), hostServe: { mode: 'static', root: '/etc' } }).hostServe,
        ).toBeUndefined();
        expect(
            sanitizeDevSitePatch({ ...base(), hostServe: { mode: 'static', root: '../secrets' } }).hostServe,
        ).toBeUndefined();
    });

    it('a serve-mode change needs a restart', () => {
        expect(
            devSiteReconfigureNeedsRestart(
                base({ hostServe: { mode: 'static', root: 'dist' } }),
                base({ hostServe: { mode: 'static', root: 'build' } }),
            ),
        ).toBe(true);
    });

    it('an EXPLICIT clear emits the key so the merge drops a stored serve (static → proxy)', () => {
        // The Edit form switching a site back to its OWN dev server passes a cleared
        // hostServe. Sanitize must EMIT the key (present, undefined value): the write
        // merges `{...previous, ...clean}`, so a MISSING key would keep the site
        // static forever. Presence-with-undefined is what overrides the stored value.
        const cleared = sanitizeDevSitePatch({ ...base(), hostServe: null as never });
        expect('hostServe' in cleared).toBe(true);
        expect(cleared.hostServe).toBeUndefined();
        // A patch that never mentions hostServe leaves the key ABSENT — so a cosmetic
        // edit (renaming, toggling enabled) can never clear a site's serve mode.
        expect('hostServe' in sanitizeDevSitePatch(base())).toBe(false);
    });
});

describe('external-browser opt-in (story #238 P1) — `browserExposed`', () => {
    it('sanitize keeps browserExposed only as a boolean', () => {
        expect(sanitizeDevSitePatch({ ...base(), browserExposed: true }).browserExposed).toBe(true);
        expect(sanitizeDevSitePatch({ ...base(), browserExposed: false }).browserExposed).toBe(false);
        // A non-boolean is dropped, never coerced.
        expect(
            sanitizeDevSitePatch({ ...base(), browserExposed: 'yes' as unknown as boolean }).browserExposed,
        ).toBeUndefined();
        // Absent stays absent (opt-in: undefined ⇒ not exposed).
        expect(sanitizeDevSitePatch(base()).browserExposed).toBeUndefined();
    });

    it('toggling browserExposed does NOT restart the dev server', () => {
        // It adds/removes the site from the HOST Caddy + hosts-file + leaf (the
        // external-browser reconcile), which never touches the running process —
        // so it must not be a restart-forcing (RECONFIGURE) key.
        expect(
            devSiteReconfigureNeedsRestart(base({ browserExposed: false }), base({ browserExposed: true })),
        ).toBe(false);
    });
});
