import { describe, expect, it } from 'vitest';
import {
    effectiveCommand,
    sandboxCommandFor,
    sanitizeDevSitePatch,
    devSiteReconfigureNeedsRestart,
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

    it('does NOT migrate when a custom image supplies the toolchain (#141)', () => {
        // The migration exists only because the dev-base image lacks frankenphp; a
        // custom frankenphp image HAS it, so even the php-server recipe runs unchanged.
        const cfg = base({
            server: 'frankenphp',
            stack: 'php',
            port: 8080,
            image: 'dunglas/frankenphp:1-php8.4',
            serve: ['frankenphp', 'php-server', '--listen', '0.0.0.0:8080', '--root', 'public/'],
        });
        expect(sandboxCommandFor(cfg)).toEqual([
            'frankenphp',
            'php-server',
            '--listen',
            '0.0.0.0:8080',
            '--root',
            'public/',
        ]);
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
