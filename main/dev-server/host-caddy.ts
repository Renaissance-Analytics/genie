/**
 * Driving the HOST Caddy for host-native `.gen` sites (story #238, task #673).
 *
 * The sandbox model runs Caddy INSIDE the workspace container (caddy-proxy.ts) and
 * reaches it with `runtime.exec`. Host-native runs ONE Caddy on the host that owns
 * :443, so this module spawns the caddy BINARY directly. The converge step is the
 * same idempotent shape: write the generated Caddyfile, then RELOAD a running Caddy
 * (its admin API, no restart, connections preserved) or START it detached if it
 * isn't up yet. Either path leaves Caddy serving the config just written.
 *
 * The spawn + fs are injected so "reload, else start" is unit-testable; the real
 * bindings (node child_process, fs) are thin and exercised by CI E2E. Never throws.
 */

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export interface HostCaddyDeps {
    /** Absolute path to the caddy binary Genie ships/locates on the host. */
    caddyBin: string;
    /** Where the host Caddyfile is written. */
    configPath: string;
    writeFile: (path: string, content: string) => Promise<void>;
    /** Run a command to completion (used for `caddy reload`, which returns quickly). */
    run: (argv: string[]) => Promise<{ code: number; stderr?: string }>;
    /** Start a detached, long-lived process (used for `caddy start`). */
    startDetached: (argv: string[]) => Promise<{ ok: boolean; error?: string }>;
}

export type ApplyHostCaddyResult = { ok: true } | { ok: false; error: string };

/** `caddy reload` argv — hot-swaps the config on a running Caddy via its admin API. */
export function hostCaddyReloadArgv(caddyBin: string, configPath: string): string[] {
    return [caddyBin, 'reload', '--config', configPath, '--adapter', 'caddyfile'];
}

/** `caddy start` argv — brings Caddy up (detached) when it isn't already running. */
export function hostCaddyStartArgv(caddyBin: string, configPath: string): string[] {
    return [caddyBin, 'start', '--config', configPath, '--adapter', 'caddyfile'];
}

/**
 * Point the host Caddy at exactly `caddyfile`: write it, then reload (or start).
 * `reload` fails when no Caddy is running yet — that's the signal to `start`, not
 * an error.
 */
export async function applyHostCaddy(caddyfile: string, deps: HostCaddyDeps): Promise<ApplyHostCaddyResult> {
    try {
        await deps.writeFile(deps.configPath, caddyfile);
    } catch (e) {
        return { ok: false, error: `could not write the host Caddyfile: ${messageOf(e)}` };
    }
    try {
        const reload = await deps.run(hostCaddyReloadArgv(deps.caddyBin, deps.configPath));
        if (reload.code === 0) return { ok: true };
        // Not running ⇒ start it.
        const started = await deps.startDetached(hostCaddyStartArgv(deps.caddyBin, deps.configPath));
        if (started.ok) return { ok: true };
        return { ok: false, error: `could not start the host Caddy: ${started.error ?? 'unknown error'}` };
    } catch (e) {
        return { ok: false, error: `could not apply the host Caddy config: ${messageOf(e)}` };
    }
}
