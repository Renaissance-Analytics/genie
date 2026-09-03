/**
 * Driving the HOST Caddy for host-native `.gen` sites (story #238, task #673).
 *
 * The sandbox model runs Caddy INSIDE the workspace container (caddy-proxy.ts) and
 * reaches it with `runtime.exec`. Host-native runs ONE Caddy on the host that owns
 * :443, so this module spawns the caddy BINARY directly. The converge step is the
 * same idempotent shape: write the generated Caddyfile, then RELOAD a running Caddy
 * (its admin API, no restart, connections preserved) or START it detached if it
 * isn't up yet.
 *
 * `ok` on either path is EVIDENCE, not optimism: `caddy reload` exits 0 once the
 * running admin API has accepted the config, and `caddy start` exits 0 only once
 * the server it daemonised has signalled it is up and serving. A start whose
 * finish cannot be seen is reported as a failure — see {@link awaitCaddyStart},
 * which exists because the real binding used to resolve `{ok: true}` on a 50ms
 * timer that never looked at the process at all.
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
    /**
     * Start a detached, long-lived process (used for `caddy start`).
     *
     * CONTRACT: `ok` means the start was OBSERVED to succeed — the `caddy start`
     * process exited 0, which it does only after the server it daemonised is up
     * and serving. Never resolve `ok` on a timer: see {@link awaitCaddyStart}.
     */
    startDetached: (argv: string[]) => Promise<{ ok: boolean; error?: string }>;
}

/** The bits of a spawned `caddy start` {@link awaitCaddyStart} listens on.
 *  Structural, so a real `ChildProcess` and a test fake both satisfy it and this
 *  module keeps needing no node imports. */
export interface CaddyStartProcess {
    on(event: 'error', listener: (error: Error) => void): unknown;
    on(event: 'exit', listener: (code: number | null) => void): unknown;
    on(event: 'close', listener: (code: number | null) => void): unknown;
    stderr?: { on(event: 'data', listener: (chunk: unknown) => void): unknown } | null;
    unref?(): void;
}

/** How long to wait for `caddy start` to say whether it came up. Generous: it
 *  covers a first-run certificate provision, and expiring is a REPORTED failure
 *  rather than a wrong success, so there is nothing to gain by being tight. */
export const HOST_CADDY_START_TIMEOUT_MS = 20_000;

/** After a non-zero exit, how long to let the stderr pipe deliver the reason. */
export const HOST_CADDY_START_STDERR_GRACE_MS = 150;

/** How much of caddy's stderr is kept for the failure message. Caddy's reason
 *  ("listen tcp :443: bind: address already in use") is one line; the daemon it
 *  spawns may then log down the same pipe indefinitely. */
const STDERR_KEEP_CHARS = 4_000;

/**
 * WAIT for a `caddy start`, and report what it established.
 *
 * `caddy start` is not fire-and-forget: it daemonises the server and then exits
 * — 0 only once that server has signalled it is up and serving. That exit code
 * is the readiness answer, and it is the only one available without opening a
 * socket. The binding used to ignore it entirely:
 *
 *     // `caddy start` daemonises and exits; give it a tick to fail loudly.
 *     setTimeout(() => resolve({ ok: true }), 50);
 *
 * which reported the host Caddy converged when :443 was taken or the binary was
 * missing, and let a following `reload` race an admin API that was not up.
 * Lengthening that timer fixes nothing: a timer that always passes cannot fail.
 *
 * The decision is taken on `exit`, not `close`. The daemonised `caddy run` can
 * INHERIT this process's stderr pipe, which would hold `close` open for as long
 * as the daemon lives — waiting for it is how this hangs instead of answering.
 * A non-zero exit gets a short grace for stderr to deliver caddy's reason, cut
 * short by `close` when the pipe does drain.
 */
export function awaitCaddyStart(
    child: CaddyStartProcess,
    opts: { timeoutMs?: number; stderrGraceMs?: number } = {},
): Promise<{ ok: boolean; error?: string }> {
    const timeoutMs = opts.timeoutMs ?? HOST_CADDY_START_TIMEOUT_MS;
    const graceMs = opts.stderrGraceMs ?? HOST_CADDY_START_STDERR_GRACE_MS;
    return new Promise((resolve) => {
        let stderr = '';
        let settled = false;
        let exitCode: number | null | undefined;
        const timers: Array<ReturnType<typeof setTimeout>> = [];
        const done = (r: { ok: boolean; error?: string }): void => {
            if (settled) return;
            settled = true;
            for (const t of timers) clearTimeout(t);
            // Only NOW. Releasing the handle before the exit would drop the very
            // thing the answer is read from.
            child.unref?.();
            resolve(r);
        };
        const failedExit = (): void =>
            done({
                ok: false,
                error:
                    stderr.trim() ||
                    `\`caddy start\` exited ${exitCode === null || exitCode === undefined ? 'without a code' : String(exitCode)}`,
            });

        // DRAIN the pipe, but do not hoard it. `caddy start` hands its stderr to
        // the `caddy run` it daemonises, which then logs down it for as long as
        // it lives — so the listener stays (an unread pipe eventually blocks the
        // writer) while what is retained is capped, and abandoned once answered.
        child.stderr?.on('data', (chunk) => {
            if (settled || stderr.length >= STDERR_KEEP_CHARS) return;
            stderr = (stderr + String(chunk)).slice(0, STDERR_KEEP_CHARS);
        });
        child.on('error', (e) => done({ ok: false, error: e.message }));
        child.on('exit', (code) => {
            if (code === 0) return done({ ok: true });
            exitCode = code;
            timers.push(setTimeout(failedExit, graceMs));
        });
        child.on('close', () => {
            if (exitCode !== undefined) failedExit();
        });
        timers.push(
            setTimeout(
                () =>
                    done({
                        ok: false,
                        error:
                            `\`caddy start\` had not finished after ${timeoutMs}ms, so Genie cannot confirm the host ` +
                            `Caddy is serving the config it just wrote. Check whether another process holds :443, and ` +
                            `whether the caddy binary runs at a prompt.`,
                    }),
                timeoutMs,
            ),
        );
    });
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
