import { execFile, spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync } from 'node:fs';
import { dirname } from 'node:path';
import { resolveProgram } from '../core/program-lookup.js';
import { systemProcessTree } from '../core/process-tree.js';
import { endChildTrees } from './end-child-trees.js';

/**
 * THE PROCESS-CREATING CODE `execFileRunner` STANDS ON (genie#1397), run by the SPAWN HOST (main/spawn-host.ts) — a child
 * of Genie's — never on Electron main's thread: Windows creates a process synchronously on the calling thread, and on the
 * owner's machine the Docker CLI spawned here held main up to 18.3 s at a time (600 s in one session).
 *
 * Main loads this module only as the fallback when the spawn host cannot start, which the spawn host client logs.
 * Everywhere else (genie-host, the live checks, the tests) runs it in-process, where a held thread holds no window.
 *
 * `execFile`, never a shell unless asked: arguments reach the binary as-is, so a version string or a package id can never
 * become a command (the §2.4 thread-id lesson, applied to tools). A missing binary rejects with `ENOENT`, which the
 * prober reads as not-installed; a non-zero exit is a RESULT with its code, because for a probe and for an update the
 * exit code is a fact to report, not a failure to throw. A hang is cut at the timeout (`ETIMEDOUT`).
 */

export interface RunOptions {
    readonly timeoutMs?: number;
    readonly cwd?: string;
    /** Added to the child's inherited environment for this call only (Genie's own is not changed). */
    readonly env?: Readonly<Record<string, string>>;
    /** Run `binary` as a command line through the platform's shell (a provider's own status command). */
    readonly shell?: boolean;
}

export const DEFAULT_TIMEOUT_MS = 20_000;

/** Both streams as written, for a caller that must not lose either (a container's log: Postgres writes only to stderr). */
export interface RunStreams {
    readonly stdout: string;
    readonly stderr: string;
}

export interface RunResult {
    readonly stdout: string;
    readonly exitCode: number;
    readonly streams: RunStreams;
}

/**
 * Tynn #698: A COMMAND CAN NEITHER WAIT ON A PROMPT NOR OUTLIVE ITS LIMIT. Its input is closed at once, so a question it asks
 * reads end-of-input instead of holding the whole limit (the Toolchain's Update sat on "Starting"). At the limit it is ended
 * WITH WHAT IT STARTED (end-child-trees.ts, the process tree's rules), not only the cmd.exe in front of npm or an installer;
 * then it is reported as ETIMEDOUT. Should the ending itself not end it, the call is still answered a little later.
 */
const ENDED_GRACE_MS = 15_000;

export function execInProcess(binary: string, args: readonly string[], options: RunOptions = {}): Promise<RunResult> {
    return new Promise((resolve, reject) => {
        const limit = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
        let timedOut = false;
        let settled = false;
        let grace: NodeJS.Timeout | null = null;
        const timedOutError = () => Object.assign(new Error(`${binary} did not answer within ${limit} ms`), { code: 'ETIMEDOUT' });
        const child = execFile(
            options.shell === true ? binary : resolveProgram(binary),
            [...args],
            { windowsHide: true, maxBuffer: 4 * 1024 * 1024, ...(options.cwd ? { cwd: options.cwd } : {}), ...(options.env ? { env: { ...process.env, ...options.env } } : {}), shell: options.shell === true },
            (error, stdout, stderr) => {
                clearTimeout(timer);
                if (grace) clearTimeout(grace);
                if (settled) return;
                settled = true;
                if (error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
                    reject(Object.assign(new Error(`spawn ${binary} ENOENT`), { code: 'ENOENT' }));
                    return;
                }
                if (timedOut) {
                    reject(timedOutError());
                    return;
                }
                const exitCode = typeof child.exitCode === 'number' ? child.exitCode : error ? 1 : 0;
                // Some tools print their banner on stderr (java, older php builds); the prober parses whatever came out.
                resolve({ stdout: String(stdout) || String(stderr), exitCode, streams: { stdout: String(stdout), stderr: String(stderr) } });
            },
        );
        // Nothing is ever written to a command Genie runs: its input ends now.
        child.stdin?.end();
        const timer = setTimeout(() => {
            timedOut = true;
            void endChildTrees([child], systemProcessTree).catch(() => { child.kill(); });
            grace = setTimeout(() => {
                if (settled) return;
                settled = true;
                reject(timedOutError());
            }, ENDED_GRACE_MS);
        }, limit);
    });
}

/** A long-lived process's stdout, line by line (`docker events`), until it ends — with why. `stop()` ends it. */
export type LineStream = (binary: string, args: readonly string[], onLine: (line: string) => void, onEnd: (reason: string) => void) => { stop(): void };

export const streamInProcess: LineStream = (binary, args, onLine, onEnd) => {
    let ended = false;
    let stopped = false;
    const end = (reason: string) => { if (!ended) { ended = true; onEnd(reason); } };
    const child = spawn(resolveProgram(binary), [...args], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let buffer = '';
    let stderr = '';
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
        buffer += chunk;
        let nl = buffer.indexOf('\n');
        while (nl >= 0) {
            const line = buffer.slice(0, nl).replace(/\r$/, '');
            buffer = buffer.slice(nl + 1);
            if (line !== '') onLine(line);
            nl = buffer.indexOf('\n');
        }
    });
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-500); });
    child.on('error', (error) => end(error.message));
    child.on('close', (code) => end(stopped ? 'stopped' : `${binary} ${args[0] ?? ''} exited with code ${code ?? '?'}${stderr.trim() ? `: ${stderr.trim()}` : ''}`));
    return {
        stop: () => {
            stopped = true;
            child.kill();
        },
    };
};

/**
 * A process of Genie's own that runs on by itself (the Genie browser: a real Electron, so the env has no
 * ELECTRON_RUN_AS_NODE), detached, its output appended to `logFile`. Its pid, or null. Created by the spawn host for
 * genie-host (Tynn #535), and by genie-host itself only between that child's lives.
 */
export function spawnDetachedProcess(file: string, args: readonly string[], env: Readonly<Record<string, string>>, logFile: string, hide = false): number | null {
    mkdirSync(dirname(logFile), { recursive: true });
    const out = openSync(logFile, 'a');
    try {
        const own: Record<string, string> = { ...env };
        for (const k of Object.keys(own)) if (k.toUpperCase() === 'ELECTRON_RUN_AS_NODE') delete own[k];
        const child = spawn(file, [...args], { detached: true, windowsHide: hide, stdio: ['ignore', out, out], env: own });
        child.on('error', () => {});
        child.unref();
        return child.pid ?? null;
    } finally {
        closeSync(out);
    }
}
