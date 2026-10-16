import { spawn } from 'node:child_process';
import { shellLaunch } from '../core/shell-launch.js';
import type { ServiceExec } from './mcp-tools-hosting.js';

/** How much of a `services exec` command's output is kept: its tail, in characters. */
const OUTPUT_MAX = 262_144;

/**
 * `services exec` for real: the command line through the platform's shell (core/shell-launch.ts), in the folder, with
 * the workspace's service variables over Genie's own environment. Output (stdout and stderr, as they came) is kept to
 * its tail; at `timeoutMs` the process is killed and `timedOut` says so. Asynchronous throughout: nothing here blocks
 * Genie's main thread while a migration runs.
 */
export const runServiceExec: ServiceExec = ({ command, cwd, env, timeoutMs }) =>
    new Promise((resolve) => {
        const launch = shellLaunch(process.platform, () => ({ command: process.env.SHELL || '/bin/sh', args: [] }), command);
        let output = '';
        let timedOut = false;
        const keep = (chunk: Buffer) => {
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
        child.stdout?.on('data', keep);
        child.stderr?.on('data', keep);
        const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
        child.on('error', (error) => { clearTimeout(timer); resolve({ exitCode: null, output: `${output}${output ? '\n' : ''}could not run the command: ${error.message}`, timedOut }); });
        child.on('close', (code) => { clearTimeout(timer); resolve({ exitCode: code, output, timedOut }); });
    });
