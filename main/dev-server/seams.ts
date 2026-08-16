import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { quoteWinToken } from './host-site-process';
import type {
    CommandResult,
    CommandRunner,
    RunOptions,
    StreamHandle,
    StreamOptions,
} from './container-runtime';

/**
 * The real process I/O behind the adapters' injected seam.
 *
 * One module rather than a spawn inside each adapter, for the same reason
 * `../hosting/services/seams.ts` gives — so a test substitutes a fake without
 * ever loading `node:child_process`, and so the spawn-hardening rules are
 * written down once:
 *
 *   - **never `shell: true`.** Every argv here contains a user-supplied path,
 *     image name or command; a shell would turn a directory containing `&` into
 *     argument injection. Without one, every token is a literal argument and the
 *     whole class of bug is gone rather than escaped around.
 *   - **always `windowsHide`.** A managed background call must not flash a
 *     console window — that is what makes an Electron app look broken.
 *   - **resolve, never reject.** A missing `docker` on PATH comes back as
 *     `{ code: null, stderr: 'spawn docker ENOENT' }`, because "the executable
 *     is not there" is the same kind of answer as "it exited non-zero", and
 *     detection is built on being able to ask without a try/catch.
 */

/** Cap what we keep from a chatty command — this output exists to explain. */
const OUTPUT_TAIL_LIMIT = 8_000;

/** A container CLI call that has not answered by now is wedged, not slow.
 *  Generous, because a first `run` may be extracting a large image layer. */
const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * The one spawn+capture implementation. `shell` is a parameter HERE and not a
 * {@link RunOptions} field on purpose: {@link defaultCommandRunner} hard-codes
 * `false`, so no caller can weaken the container runner's no-shell rule by
 * passing an option, while {@link hostToolCommandRunner} can still do the one
 * thing Windows shims require.
 */
function runCaptured(
    command: string,
    args: string[],
    opts: RunOptions,
    shell: boolean,
): Promise<CommandResult> {
    return new Promise((resolve) => {
        {
            const child = spawn(command, args, {
                cwd: opts.cwd,
                env: opts.env ? { ...process.env, ...opts.env } : process.env,
                shell,
                windowsHide: true,
                stdio: ['ignore', 'pipe', 'pipe'],
            });

            let stdout = '';
            let stderr = '';
            let settled = false;
            const finish = (result: CommandResult) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                resolve(result);
            };

            const timer = setTimeout(() => {
                try {
                    child.kill();
                } catch {
                    /* already gone */
                }
                finish({
                    code: null,
                    stdout,
                    stderr: `${stderr}\n${command} timed out after ${
                        opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
                    }ms`.trim(),
                });
            }, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
            // Do not hold the event loop open on the timer alone.
            timer.unref?.();

            child.stdout?.on('data', (chunk) => {
                stdout = (stdout + String(chunk)).slice(-OUTPUT_TAIL_LIMIT);
            });
            child.stderr?.on('data', (chunk) => {
                stderr = (stderr + String(chunk)).slice(-OUTPUT_TAIL_LIMIT);
            });
            child.on('error', (e) => finish({ code: null, stdout, stderr: String(e) }));
            child.on('close', (code) => finish({ code, stdout, stderr }));
        }
    });
}

export const defaultCommandRunner: CommandRunner = {
    run(command: string, args: string[], opts: RunOptions = {}): Promise<CommandResult> {
        return runCaptured(command, args, opts, false);
    },

    stream(command: string, args: string[], opts: StreamOptions): StreamHandle {
        const child = spawn(command, args, {
            env: opts.env ? { ...process.env, ...opts.env } : process.env,
            shell: false,
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        // `docker logs -f` writes the container's stdout AND stderr; both are
        // "the log" as far as anything reading this is concerned.
        child.stdout?.on('data', (chunk) => opts.onData(String(chunk)));
        child.stderr?.on('data', (chunk) => opts.onData(String(chunk)));

        const exited = new Promise<number | null>((resolve) => {
            child.on('error', () => resolve(null));
            child.on('close', (code) => resolve(code));
        });

        return {
            get pid() {
                return child.pid;
            },
            exited,
            stop() {
                try {
                    child.kill();
                } catch {
                    /* already gone */
                }
            },
        };
    },
};

// --- host TOOLS, which on Windows are often shims (genie#205) ---------------

/**
 * How to invoke a HOST TOOL (`npm`, `composer`, `codex`, `php`, …) on this
 * platform.
 *
 * On Windows those are `.cmd` / `.bat` SHIMS, not `.exe`, and `spawn` launches
 * `.exe` only — so the runner above returns `spawn npm ENOENT` for every one of
 * them. That single fact produced two visible bugs: detection reported installed
 * tools as MISSING (so the setup wizard offered to install what was already
 * there), and an `npm i -g` install step could never run.
 *
 * Resolving the shim's real path is not a way out: spawning a `.cmd` directly
 * throws `EINVAL` on modern Node (hardened after CVE-2024-27980). A shim must go
 * through a shell.
 *
 * Which makes the quoting the load-bearing part — under a bare `shell: true` an
 * `&` inside an argument really does execute. Every token goes through
 * {@link quoteWinToken}, the SAME helper the host-native dev-server spawn uses
 * (`host-site-process.ts`), which reached this conclusion first for the same
 * reason. Sharing it is deliberate: two copies drift, and the drift becomes a
 * hole in whichever one stopped being maintained.
 *
 * Deliberately NOT applied to {@link defaultCommandRunner}: the container calls
 * it carries take user-supplied paths and image names, and its "never
 * `shell: true`" rule is the right one there.
 */
export function hostToolInvocation(
    command: string,
    args: string[],
    platform: NodeJS.Platform | string,
): { file: string; args: string[]; shell: boolean } {
    if (platform !== 'win32') return { file: command, args, shell: false };
    return { file: [command, ...args].map(quoteWinToken).join(' '), args: [], shell: true };
}

/**
 * {@link defaultCommandRunner}, but able to launch a Windows shim. Used for host
 * TOOL probes and installs; everything else keeps the no-shell runner.
 */
export const hostToolCommandRunner: CommandRunner = {
    run(command: string, args: string[], opts: RunOptions = {}): Promise<CommandResult> {
        const inv = hostToolInvocation(command, args, process.platform);
        return runCaptured(inv.file, inv.args, opts, inv.shell);
    },
    // Streaming is a container concern (`docker logs -f`); host tools do not use
    // it, so it stays on the no-shell path.
    stream: (command, args, opts) => defaultCommandRunner.stream(command, args, opts),
};

/**
 * Does this path exist as a FILE?
 *
 * The seam a runtime-LIBRARY probe needs (`toolchain-detect`): a DLL has no
 * `--version` to ask, so its presence is the presence of the file. Same contract
 * as the runners above — it resolves, never rejects, because "it is not there"
 * is an answer and not an error.
 */
export async function fileExistsSeam(path: string): Promise<boolean> {
    try {
        return (await stat(path)).isFile();
    } catch {
        return false;
    }
}
