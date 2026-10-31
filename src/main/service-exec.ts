import { spawn } from 'node:child_process';
import { shellLaunch } from '../core/shell-launch.js';
import { describeProcesses, stillRunning, subtreeOf, systemProcessTree, unionOf, type ProcessInfo, type ProcessTree } from '../core/process-tree.js';
import type { ServiceExec } from './mcp-tools-hosting.js';

/** How much of a `services exec` command's output is kept: its tail, in characters. */
const OUTPUT_MAX = 262_144;

/** How often a client still waiting hears how much the command has written (genie#1360). */
export const EXEC_PROGRESS_MS = 10_000;

/** After a stop's reap: how many fresh readings may confirm the tree has exited, and the pause between them (genie#1372). */
const EXIT_CHECKS = 10;
const EXIT_CHECK_MS = 100;

/**
 * `services exec` for real: the command line through the platform's shell (core/shell-launch.ts), in the folder, with
 * the workspace's service variables over Genie's own environment. Output (stdout and stderr, as they came) is kept to
 * its tail; at `timeoutMs` the command is stopped and `timedOut` says so. Asynchronous throughout: nothing here blocks
 * Genie's main thread while a migration runs.
 *
 * STOPPING IS THE COMMAND'S WHOLE TREE, AND ONLY IT (genie#1360). When the MCP call goes away (`signal`) — or the
 * timeout ends it — the shell Genie spawned and everything under it is stopped: on Windows killing the shell leaves its
 * children running, and on POSIX a shell that forked does the same. The tree is read the way a session's stop reads
 * one (core/process-tree.ts: pid AND start time, no `/T`, the plausibility cap), rooted at THIS command's own shell, so
 * another command's tree — another agent's migration running beside it — is never in it. The shell itself is killed
 * as well, so a refused or failed reading still ends the command Genie started.
 */
export function makeServiceExec(tree: ProcessTree): ServiceExec {
    return ({ command, cwd, env, timeoutMs, signal, progress }) =>
        new Promise((resolve) => {
            if (signal?.aborted) {
                resolve({ exitCode: null, output: '', timedOut: false, aborted: true });
                return;
            }
            const launch = shellLaunch(process.platform, () => ({ command: process.env.SHELL || '/bin/sh', args: [] }), command);
            let output = '';
            let written = 0;
            let timedOut = false;
            let aborted = false;
            const keep = (chunk: Buffer) => {
                written += chunk.length;
                output += chunk.toString('utf8');
                if (output.length > OUTPUT_MAX) output = output.slice(-OUTPUT_MAX);
            };
            let child: ReturnType<typeof spawn>;
            try {
                child = spawn(launch.command, launch.args, { cwd, env: { ...process.env, ...env }, windowsHide: true, windowsVerbatimArguments: process.platform === 'win32' });
            } catch (error) {
                resolve({ exitCode: null, output: `could not start the command: ${error instanceof Error ? error.message : String(error)}`, timedOut: false });
                return;
            }
            let exited = false;
            const read = (): Promise<readonly ProcessInfo[] | null> => (tree.read ? tree.read() : Promise.resolve(tree.snapshot()));
            const reap = (targets: readonly ProcessInfo[], now: readonly ProcessInfo[]): Promise<unknown> =>
                tree.reap ? tree.reap(targets, now) : Promise.resolve(tree.killTree(targets, now));
            /** Set once a stop has begun: the command's result waits for it, so "stopped" is never reported early. */
            let stopping: Promise<string | null> | null = null;
            const stop = (): Promise<string | null> => (stopping ??= (async (): Promise<string | null> => {
                const pid = child.pid;
                let members: ProcessInfo[] = [];
                if (pid !== undefined && !exited) {
                    const now = await read();
                    // The shell as Genie's own child: a pid that is not (any more) ours roots nothing.
                    const root = now?.find((p) => p.pid === pid && p.ppid === process.pid);
                    if (now && root && !exited) {
                        members = subtreeOf(now, [root]);
                        await reap(members, now);
                    }
                }
                if (!exited) child.kill();
                return members.length > 0 ? untilExited(members) : null;
            })());
            /*
             * STOPPED MEANS EXITED (genie#1372). On Windows a killed process has its exit code — `process.kill(pid, 0)`
             * already says it is gone — before it has finished exiting: its handles and its current directory (the
             * command's folder) are released after. Measured on genie-test-windows: in 10 of 33 aborts the folder was
             * still EBUSY the moment the abort resolved, and no process had survived. So the stop is done only when a
             * fresh reading no longer lists any process it reaped (a listed process still exists, exited or not), and
             * anything still running, or started under a member just before its kill, is reaped again. Bounded: a
             * process that will not go is NAMED in the result, never passed off as stopped. Same identities as the reap
             * (pid, start time, name), so a recycled pid is never waited on or killed.
             */
            const untilExited = async (reaped: ProcessInfo[]): Promise<string | null> => {
                let members = reaped;
                let left: ProcessInfo[] = members;
                for (let attempt = 0; attempt < EXIT_CHECKS; attempt += 1) {
                    const now = await read();
                    if (now === null) return 'Genie could not read the machine’s processes to confirm the command’s ended.';
                    // A member still running may have started a child after the reading the reap used.
                    members = unionOf(members, subtreeOf(now, stillRunning(members, now)));
                    left = stillRunning(members, now);
                    if (left.length === 0) return null;
                    await reap(left, now);
                    await new Promise((r) => setTimeout(r, EXIT_CHECK_MS));
                }
                return `still running after the stop: ${describeProcesses(left)}`;
            };
            child.stdout?.on('data', keep);
            child.stderr?.on('data', keep);
            const timer = setTimeout(() => { timedOut = true; void stop(); }, timeoutMs);
            const onAbort = () => { aborted = true; void stop(); };
            signal?.addEventListener('abort', onAbort, { once: true });
            const ticker = progress ? setInterval(() => progress(`running: ${written} bytes of output so far`), EXEC_PROGRESS_MS) : undefined;
            const finish = () => {
                exited = true;
                clearTimeout(timer);
                if (ticker) clearInterval(ticker);
                signal?.removeEventListener('abort', onAbort);
            };
            const note = (text: string, extra: string | null): string => (extra ? `${text}${text ? '\n' : ''}${extra}` : text);
            // The result waits for a stop in flight: its tree has to have EXITED, not just been told to (genie#1372).
            const settle = async (exitCode: number | null, text: string): Promise<void> => {
                finish();
                const unconfirmed = stopping ? await stopping : null;
                resolve({ exitCode, output: note(text, unconfirmed), timedOut, ...(aborted ? { aborted } : {}) });
            };
            child.on('error', (error) => { void settle(null, `${output}${output ? '\n' : ''}could not run the command: ${error.message}`); });
            child.on('close', (code) => { void settle(code, output); });
        });
}

export const runServiceExec: ServiceExec = makeServiceExec(systemProcessTree);
