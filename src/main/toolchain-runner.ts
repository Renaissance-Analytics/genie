import type { ToolStatus } from '../core/toolchain.js';
import { probeTools, type CommandRunner, type LatestIndex } from './toolchain-prober.js';
import { execInProcess, streamInProcess, type LineStream, type RunOptions, type RunResult, type RunStreams } from './spawn-exec.js';

export type { RunOptions, RunStreams };

/**
 * THE REAL COMMAND RUNNER behind the toolchain prober, the Docker driver and every other command Genie runs.
 *
 * In Electron, NOT on main's thread (genie#1397): main.ts routes it through the spawn host (main/spawn-host-client.ts),
 * a child process that creates the processes — on Windows a process is created synchronously on the calling thread, and
 * the Docker CLI alone held the owner's main 600 s in one session. Anywhere nothing has routed it (genie-host, the live
 * checks, the tests) it runs in-process (main/spawn-exec.ts), with the same results and error codes either way:
 * `execFile`, never a shell unless asked; ENOENT for a missing binary; a non-zero exit as a result; ETIMEDOUT at the
 * timeout.
 */

interface ExecRoute {
    readonly exec: (binary: string, args: readonly string[], options?: RunOptions) => Promise<RunResult>;
    readonly stream: LineStream;
}

let route: ExecRoute | null = null;

/** Where commands are created from now on (the spawn host), or `null` for in-process. main/spawn-host-client.ts sets it. */
export function setExecRoute(next: ExecRoute | null): void {
    route = next;
}

export const execFileRunner: (binary: string, args: readonly string[], options?: RunOptions) => Promise<RunResult> = (binary, args, options = {}) =>
    route ? route.exec(binary, args, options) : execInProcess(binary, args, options);

/** A long-lived command's stdout lines (`docker events`), created where `execFileRunner`'s commands are. */
export const lineStreamRunner: LineStream = (binary, args, onLine, onEnd) =>
    route ? route.stream(binary, args, onLine, onEnd) : streamInProcess(binary, args, onLine, onEnd);

/** A command's stdout, or a rejection naming why it failed (a non-zero exit included): for callers that only want text. */
export async function execFileText(binary: string, args: readonly string[], options: RunOptions = {}): Promise<string> {
    const r = await execFileRunner(binary, args, options);
    if (r.exitCode !== 0) throw Object.assign(new Error(`${binary} ${args[0] ?? ''} exited with code ${r.exitCode}${r.streams.stderr.trim() ? `: ${r.streams.stderr.trim().slice(0, 300)}` : ''}`), { exitCode: r.exitCode });
    return r.streams.stdout;
}

/** The prober over the real runner. The index is injected so an offline machine still answers `unknown`. */
export function probeToolsLive(latest: LatestIndex, runner: CommandRunner = execFileRunner): Promise<ToolStatus[]> {
    return probeTools(runner, latest);
}
