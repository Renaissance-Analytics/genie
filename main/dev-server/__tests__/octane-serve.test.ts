import { describe, expect, it } from 'vitest';
import { octaneServeCommand, OCTANE_SERVE_ENV } from '../octane-serve';

/**
 * HOW GENIE STARTS A LARAVEL OCTANE SITE (genie#668).
 *
 * Octane can be typed as a site command today, and Genie rewrites `--port` and
 * nothing else. The rest of what an Octane server binds is derived by OCTANE from
 * that port, not allocated by anyone:
 *
 *   - FrankenPHP's admin API: `2019 + (port - 8000)` — and Octane throws when that
 *     is negative;
 *   - RoadRunner's RPC listener: `port - 1999`.
 *
 * Genie's allocator knows neither, so two Octane sites, or one Octane site and
 * any other process, can be handed ports that collide on a port nobody chose.
 * The planner makes those ports Genie's to choose and states them on the command
 * line — using only options `octane:start` actually forwards to each server, since
 * an option it does not know is a command that does not start.
 */

const PHP = '/gd/toolchain/php/8.4.24/bin/php';

describe('octaneServeCommand', () => {
    it('starts FrankenPHP on the allocated port, with its admin API on a port Genie allocated too', () => {
        expect(
            octaneServeCommand({ phpExe: PHP, server: 'frankenphp', port: 51000, adminPort: 51001, watch: false }),
        ).toEqual([
            PHP,
            '-d',
            'variables_order=EGPCS',
            'artisan',
            'octane:start',
            '--server=frankenphp',
            '--host=127.0.0.1',
            '--port=51000',
            '--admin-port=51001',
            '--no-interaction',
        ]);
    });

    it('starts RoadRunner with its RPC listener on a port Genie allocated', () => {
        expect(
            octaneServeCommand({ phpExe: PHP, server: 'roadrunner', port: 51000, rpcPort: 51002, watch: false }),
        ).toEqual([
            PHP,
            '-d',
            'variables_order=EGPCS',
            'artisan',
            'octane:start',
            '--server=roadrunner',
            '--host=127.0.0.1',
            '--port=51000',
            '--rpc-port=51002',
            '--no-interaction',
        ]);
    });

    it('starts Swoole with no second port — it binds none', () => {
        expect(octaneServeCommand({ phpExe: PHP, server: 'swoole', port: 51000, watch: false })).toEqual([
            PHP,
            '-d',
            'variables_order=EGPCS',
            'artisan',
            'octane:start',
            '--server=swoole',
            '--host=127.0.0.1',
            '--port=51000',
            '--no-interaction',
        ]);
    });

    it('adds --watch only when asked — it needs chokidar in the repo, which is not a given', () => {
        const watched = octaneServeCommand({ phpExe: PHP, server: 'swoole', port: 51000, watch: true });
        const unwatched = octaneServeCommand({ phpExe: PHP, server: 'swoole', port: 51000, watch: false });
        expect(watched).toContain('--watch');
        expect(unwatched).not.toContain('--watch');
    });

    it('never passes --admin-host: octane:start does not forward it, and an unknown option is a start that fails', () => {
        for (const server of ['frankenphp', 'roadrunner', 'swoole'] as const) {
            const argv = octaneServeCommand({
                phpExe: PHP,
                server,
                port: 51000,
                adminPort: 51001,
                rpcPort: 51002,
                watch: true,
            });
            expect(argv.some((a) => a.startsWith('--admin-host'))).toBe(false);
        }
    });

    it('REFUSES FrankenPHP without an admin port, rather than let Octane derive one', () => {
        expect(() => octaneServeCommand({ phpExe: PHP, server: 'frankenphp', port: 51000, watch: false })).toThrow(
            /admin port/,
        );
    });

    it('REFUSES RoadRunner without an RPC port, rather than let Octane derive one', () => {
        expect(() => octaneServeCommand({ phpExe: PHP, server: 'roadrunner', port: 51000, watch: false })).toThrow(
            /RPC port/,
        );
    });

    it('REFUSES a second port equal to the site port', () => {
        expect(() =>
            octaneServeCommand({ phpExe: PHP, server: 'frankenphp', port: 51000, adminPort: 51000, watch: false }),
        ).toThrow(/same port/);
        expect(() =>
            octaneServeCommand({ phpExe: PHP, server: 'roadrunner', port: 51000, rpcPort: 51000, watch: false }),
        ).toThrow(/same port/);
    });

    it('REFUSES a bare php name — the runtime is a resolved path, as for the FastCGI worker (genie#207)', () => {
        expect(() => octaneServeCommand({ phpExe: 'php', server: 'swoole', port: 51000, watch: false })).toThrow(
            /resolved path/,
        );
    });

    it('REFUSES an invalid port', () => {
        expect(() => octaneServeCommand({ phpExe: PHP, server: 'swoole', port: 0, watch: false })).toThrow();
        expect(() =>
            octaneServeCommand({ phpExe: PHP, server: 'frankenphp', port: 51000, adminPort: 70000, watch: false }),
        ).toThrow();
    });

    it('REFUSES a server Octane does not have', () => {
        expect(() =>
            octaneServeCommand({ phpExe: PHP, server: 'nginx' as never, port: 51000, watch: false }),
        ).toThrow(/server/);
    });
});

describe('OCTANE_SERVE_ENV', () => {
    it('tells Octane the site is on https, so the app generates https links behind the .gen front door', () => {
        // `.gen` is https at the front door and Octane is plain http on loopback.
        // Octane's own switch for that is OCTANE_HTTPS — the alternative people
        // reach for, trusting every proxy, is a Host/scheme-spoofing hole.
        expect(OCTANE_SERVE_ENV).toEqual({ OCTANE_HTTPS: 'true' });
    });
});
