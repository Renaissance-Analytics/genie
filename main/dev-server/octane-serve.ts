/**
 * How Genie starts a Laravel Octane site (genie#668). PURE: argv and env only.
 *
 * Octane boots the app once and feeds it requests from a long-lived server —
 * FrankenPHP, RoadRunner or Swoole — started by `php artisan octane:start`.
 * Typed as an ordinary site command it half-works: Genie rewrites `--port`, and
 * every OTHER port the server binds is derived by Octane from that one rather
 * than allocated by anybody:
 *
 *   - FrankenPHP's admin API on `2019 + (port - 8000)`, and a throw when that is
 *     negative;
 *   - RoadRunner's RPC listener on `port - 1999`.
 *
 * Genie's allocator hands out a guaranteed-free SITE port and knows nothing about
 * those, so two Octane sites — or one and any other process — can collide on a
 * port no one chose. This planner makes them Genie's to allocate and states them
 * on the command line.
 *
 * Only options `octane:start` FORWARDS to the chosen server are used. It has no
 * `--admin-host` (FrankenPHP's admin binds `localhost`), and an option it does not
 * know is a start that fails outright.
 */

/** The servers `octane:start --server=` accepts. Open Swoole runs as `swoole`. */
export type OctaneServer = 'frankenphp' | 'roadrunner' | 'swoole';

export const OCTANE_SERVERS: readonly OctaneServer[] = ['frankenphp', 'roadrunner', 'swoole'];

export function isOctaneServer(v: unknown): v is OctaneServer {
    return typeof v === 'string' && (OCTANE_SERVERS as readonly string[]).includes(v);
}

export interface OctaneServeInput {
    /** The resolved php CLI — an absolute path, never a bare name (genie#207). */
    phpExe: string;
    server: OctaneServer;
    /** The allocated site port `.gen` routes to. */
    port: number;
    /** FrankenPHP's admin API port. Required for FrankenPHP, ignored otherwise. */
    adminPort?: number;
    /** RoadRunner's RPC port. Required for RoadRunner, ignored otherwise. */
    rpcPort?: number;
    /** `--watch`: reload on file changes. Needs Node + chokidar in the repo. */
    watch: boolean;
}

/**
 * The environment an Octane site runs with, on top of the site's.
 *
 * `OCTANE_HTTPS=true`: `.gen` is https at the front door and Octane is plain http
 * on loopback, so without it the app emits `http://` links and assets that the
 * https page then refuses as mixed content. This is Octane's own switch for being
 * served behind TLS — the alternative people reach for, trusting every proxy's
 * forwarded headers, is a Host/scheme-spoofing hole.
 */
export const OCTANE_SERVE_ENV: Readonly<Record<string, string>> = Object.freeze({
    OCTANE_HTTPS: 'true',
});

function assertPort(port: number | undefined, which: string): asserts port is number {
    if (port === undefined || !Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error(`octane-serve: invalid ${which} ${JSON.stringify(port)}`);
    }
}

/** The argv that starts an Octane site. Throws on anything it cannot state honestly. */
export function octaneServeCommand(input: OctaneServeInput): string[] {
    const { phpExe, server, port, watch } = input;
    if (!isOctaneServer(server)) {
        throw new Error(`octane-serve: unknown Octane server ${JSON.stringify(server)}`);
    }
    if (typeof phpExe !== 'string' || !/[\\/]/.test(phpExe)) {
        throw new Error(
            `octane-serve: refusing php ${JSON.stringify(phpExe)} — the runtime must be a resolved path (genie#207)`,
        );
    }
    assertPort(port, 'site port');

    const serverPorts: string[] = [];
    if (server === 'frankenphp') {
        if (input.adminPort === undefined) {
            throw new Error('octane-serve: FrankenPHP needs an allocated admin port — Octane would otherwise derive one from the site port');
        }
        assertPort(input.adminPort, 'admin port');
        if (input.adminPort === port) throw new Error('octane-serve: the admin port and the site port are the same port');
        serverPorts.push(`--admin-port=${input.adminPort}`);
    } else if (server === 'roadrunner') {
        if (input.rpcPort === undefined) {
            throw new Error('octane-serve: RoadRunner needs an allocated RPC port — Octane would otherwise derive one from the site port');
        }
        assertPort(input.rpcPort, 'RPC port');
        if (input.rpcPort === port) throw new Error('octane-serve: the RPC port and the site port are the same port');
        serverPorts.push(`--rpc-port=${input.rpcPort}`);
    }

    return [
        phpExe,
        // As Sail starts Octane: the app reads its service env from `$_ENV` too
        // (genie#539 — PHP's shipped inis leave `E` out).
        '-d',
        'variables_order=EGPCS',
        'artisan',
        'octane:start',
        `--server=${server}`,
        '--host=127.0.0.1',
        `--port=${port}`,
        ...serverPorts,
        ...(watch ? ['--watch'] : []),
        // A detached site has no terminal: a prompt (Octane asks before it
        // downloads a server binary) must take its default, not hang the start.
        '--no-interaction',
    ];
}
