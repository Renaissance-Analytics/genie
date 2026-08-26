import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { quoteWinToken } from './host-site-process';
import { extendedDeadline, formatRunTimeout } from './run-budget';
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

/** What a capture says when it dropped bytes — the stable PREFIX, so a consumer
 *  can test for it with `includes()` while the marker still carries the byte
 *  counts after it. Distinctive enough not to be mistaken for a command's own
 *  output. */
export const TRUNCATION_MARKER = '[genie: output truncated';

/**
 * PURE. Append a chunk, keeping the TAIL — and SAY SO when bytes were dropped
 * (genie#280).
 *
 * Keeping the tail is right for what this cap exists for: `seams.ts` describes
 * output that "exists to explain", and for error text the last lines are the
 * useful ones. The defect was that nothing distinguished *explain* from
 * *capture*, so a caller collecting DATA got the same truncation with no signal.
 *
 * It bit for real: the CA-bundle export printed ~130KB of PEM to stdout, this
 * kept its tail, and 4 roots out of 80 survived — exit 0, a syntactically valid
 * PEM on disk, tests green. A bundle missing 95% of its anchors, presented as a
 * success.
 *
 * Front-truncation is the worst direction for precisely that reason: structured
 * output carries its header or opening delimiter first, so dropping the front
 * destroys the part that would have made the corruption detectable. Truncated
 * JSON fails to parse and gets caught; truncated PEM stays valid and does not.
 *
 * A MARKER rather than a bigger buffer. Any buffer is the wrong size eventually,
 * and raising it turns a reliable failure into a rare one, which is worse.
 *
 * The marker sits at the FRONT, where the hole is, and never displaces the
 * newest bytes — the tail is the whole point of the cap, and a marker that
 * pushed real output out of the window would trade one silent loss for another.
 */
export function appendCapped(current: string, chunk: string, limit: number): string {
    // Recover the running total from a marker already present, so N chunks
    // produce ONE marker carrying the CUMULATIVE loss rather than one marker
    // each and a count that means nothing.
    const prior = current.match(/^\[genie: output truncated — (\d+) bytes dropped[^\]]*\]\n/);
    const priorDropped = prior ? Number(prior[1]) : 0;
    const body = prior ? current.slice(prior[0].length) : current;

    const joined = body + chunk;
    if (joined.length <= limit) {
        return priorDropped > 0 ? markerFor(priorDropped) + joined : joined;
    }
    const dropped = priorDropped + (joined.length - limit);
    return markerFor(dropped) + joined.slice(-limit);
}

function markerFor(dropped: number): string {
    return `${TRUNCATION_MARKER} — ${dropped} bytes dropped from the START; only the most recent output is kept]\n`;
}

/**
 * A container CLI call that has not answered by now is wedged, not slow.
 * Generous, because a first `run` may be extracting a large image layer.
 *
 * It is a PROBE budget, and callers doing something slower than a probe have to
 * say so — a package install that silently inherited this number is the bug
 * `run-budget.ts` exists for.
 */
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
            let timer: ReturnType<typeof setTimeout>;
            const finish = (result: CommandResult) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                resolve(result);
            };

            // The deadline MOVES: with `idleGraceMs`, output pushes it out (see
            // `run-budget.ts` — a slow install is not a hung one). So the timer
            // is re-armed for the remainder rather than reset on every chunk,
            // which would mean a `clearTimeout`/`setTimeout` pair per line of a
            // chatty build.
            const startedAt = Date.now();
            const budgetMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
            let deadline = startedAt + budgetMs;

            const onDeadline = () => {
                const remaining = deadline - Date.now();
                if (remaining > 0) return arm(remaining);
                try {
                    child.kill();
                } catch {
                    /* already gone */
                }
                finish({
                    code: null,
                    stdout,
                    stderr: `${stderr}\n${formatRunTimeout(
                        command,
                        Date.now() - startedAt,
                        opts.timeoutNote,
                    )}`.trim(),
                });
            };
            const arm = (ms: number) => {
                timer = setTimeout(onDeadline, ms);
                // Do not hold the event loop open on the timer alone.
                timer.unref?.();
            };
            arm(deadline - startedAt);

            /** Output means the child is alive; give it more time to finish. */
            const sawOutput = () => {
                if (!opts.idleGraceMs) return;
                deadline = extendedDeadline({
                    startedAt,
                    now: Date.now(),
                    deadline,
                    idleGraceMs: opts.idleGraceMs,
                    // No ceiling given → one grace period past the budget, so
                    // `idleGraceMs` alone is still a bounded, sensible request.
                    ceilingMs: opts.ceilingMs ?? budgetMs + opts.idleGraceMs,
                });
            };

            child.stdout?.on('data', (chunk) => {
                stdout = appendCapped(stdout, String(chunk), OUTPUT_TAIL_LIMIT);
                sawOutput();
            });
            child.stderr?.on('data', (chunk) => {
                stderr = appendCapped(stderr, String(chunk), OUTPUT_TAIL_LIMIT);
                sawOutput();
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
