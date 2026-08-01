import { spawn } from 'node:child_process';
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

export const defaultCommandRunner: CommandRunner = {
    run(command: string, args: string[], opts: RunOptions = {}): Promise<CommandResult> {
        return new Promise((resolve) => {
            const child = spawn(command, args, {
                cwd: opts.cwd,
                env: opts.env ? { ...process.env, ...opts.env } : process.env,
                shell: false,
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
        });
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
