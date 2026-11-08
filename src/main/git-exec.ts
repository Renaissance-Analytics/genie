import { execFile, type ExecFileOptions } from 'node:child_process';

/**
 * WHERE GIT'S PROCESSES ARE CREATED (Tynn #532). Windows creates a process synchronously on the calling thread: measured in
 * the UI-lag row on the Windows runner, one git read held genie-host 295 ms inside `spawn`, and a build runs one every
 * batch. So genie-host creates none of git's processes itself: it routes them to its spawn-host child
 * (spawn-host-client.ts `gitExec`), as genie#1397 did for the window's commands. Everything that DECIDES stays where it was —
 * the read limit, the job a read runs in (genie-launch.exe `job`), and the walk that ends a read's tree (git-ports.ts):
 * they hold a {@link GitChild}, and the child's pid, kill, exit and stdin are the real git's, over the wire.
 *
 * With no route (a test, the window, a host whose child is not up) git is created here, as before.
 */

/** The part of a ChildProcess that git's callers and the read limit use. */
export interface GitChild {
    readonly pid?: number | undefined;
    readonly exitCode: number | null;
    readonly signalCode: NodeJS.Signals | null;
    kill(signal?: NodeJS.Signals | number): boolean;
    once(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
    readonly stdin?: { end(input?: string): unknown } | null;
}

export type GitExecCallback = (error: Error | null, stdout: string | Buffer, stderr: string | Buffer) => void;
export type GitExec = (file: string, args: readonly string[], options: ExecFileOptions, callback: GitExecCallback) => GitChild;

let route: GitExec | null = null;

/** git's processes are created through `next` from now on; `null` creates them here again. */
export function setGitExecRoute(next: GitExec | null): void {
    route = next;
}

/** `execFile`, created where the route says. */
export const gitExecFile: GitExec = (file, args, options, callback) =>
    route ? route(file, args, options, callback) : execFile(file, [...args], options, callback);
