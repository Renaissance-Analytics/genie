import { spawn } from 'node:child_process';
import { shellLaunch } from '../core/shell-launch.js';
import { subtreeOf, systemProcessTree, type ProcessTree } from '../core/process-tree.js';
import type { ServiceExec } from './mcp-tools-hosting.js';

/** How much of a `services exec` command's output is kept: its tail, in characters. */
const OUTPUT_MAX = 262_144;

/** How often a client still waiting hears how much the command has written (genie#1360). */
export const EXEC_PROGRESS_MS = 10_000;

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
            const stop = async (): Promise<void> => {
                const pid = child.pid;
                if (pid !== undefined && !exited) {
                    const now = tree.read ? await tree.read() : tree.snapshot();
                    // The shell as Genie's own child: a pid that is not (any more) ours roots nothing.
                    const root = now?.find((p) => p.pid === pid && p.ppid === process.pid);
                    if (now && root && !exited) {
                        const targets = subtreeOf(now, [root]);
                        await (tree.reap ? tree.reap(targets, now) : Promise.resolve(tree.killTree(targets, now)));
                    }
                }
                if (!exited) child.kill();
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
            child.on('error', (error) => { finish(); resolve({ exitCode: null, output: `${output}${output ? '\n' : ''}could not run the command: ${error.message}`, timedOut, ...(aborted ? { aborted } : {}) }); });
            child.on('close', (code) => { finish(); resolve({ exitCode: code, output, timedOut, ...(aborted ? { aborted } : {}) }); });
        });
}

export const runServiceExec: ServiceExec = makeServiceExec(systemProcessTree);
