import { execFile } from 'node:child_process';
import type { ToolStatus } from '../core/toolchain.js';
import { probeTools, type CommandRunner, type LatestIndex } from './toolchain-prober.js';

/**
 * THE REAL COMMAND RUNNER behind the toolchain prober.
 *
 * `execFile`, never a shell: arguments reach the binary as-is, so a version string or a package
 * id can never become a command (the §2.4 thread-id lesson, applied to tools). A missing binary
 * rejects with `ENOENT`, which the prober reads as not-installed; a non-zero exit is a RESULT with
 * its code, because for a probe and for an update the exit code is a fact to report, not a failure
 * to throw. A hang is cut at the timeout (`ETIMEDOUT`) — a prober that waits forever on one tool
 * freezes the whole panel.
 */

export interface RunOptions {
    readonly timeoutMs?: number;
    readonly cwd?: string;
}

const DEFAULT_TIMEOUT_MS = 20_000;

export const execFileRunner: (binary: string, args: readonly string[], options?: RunOptions) => Promise<{ stdout: string; exitCode: number }> = (binary, args, options = {}) =>
    new Promise((resolve, reject) => {
        const child = execFile(
            binary,
            [...args],
            { timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS, windowsHide: true, maxBuffer: 4 * 1024 * 1024, ...(options.cwd ? { cwd: options.cwd } : {}), shell: false },
            (error, stdout, stderr) => {
                if (error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
                    reject(Object.assign(new Error(`spawn ${binary} ENOENT`), { code: 'ENOENT' }));
                    return;
                }
                if (error && (error as { killed?: boolean }).killed) {
                    reject(Object.assign(new Error(`${binary} did not answer within ${options.timeoutMs ?? DEFAULT_TIMEOUT_MS} ms`), { code: 'ETIMEDOUT' }));
                    return;
                }
                const exitCode = typeof child.exitCode === 'number' ? child.exitCode : error ? 1 : 0;
                // Some tools print their banner on stderr (java, older php builds); the prober parses whatever came out.
                resolve({ stdout: String(stdout) || String(stderr), exitCode });
            },
        );
    });

/** The prober over the real runner. The index is injected so an offline machine still answers `unknown`. */
export function probeToolsLive(latest: LatestIndex, runner: CommandRunner = execFileRunner): Promise<ToolStatus[]> {
    return probeTools(runner, latest);
}
