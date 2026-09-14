import { spawn as nodeSpawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { ShuttleEvent } from './entry';

/**
 * START THE SHUTTLE PROCESS — detached, logged to a file, answered over IPC.
 *
 * genie#346 Phase 1, `.ai/plans/genie-mcp-shuttle-spec.md` §3.3. The shuttle must
 * outlive the Genie that starts it, which rules out the two obvious ways of
 * hearing back from a child:
 *
 *  - **Its stdout/stderr as pipes.** A detached child still writing into its
 *    parent's pipes dies of EPIPE when the parent exits — which for the shuttle is
 *    every upgrade, the one moment it exists to survive. So both go to a log file.
 *  - **Polling for a file or a port.** The standing no-polling rule, and slower.
 *
 * Instead the child sends ONE IPC message — the same `started` / `refused` /
 * `invalid` event it prints — and disconnects the channel, leaving nothing tying
 * it to this process. The outcome is decided by whichever comes first: that
 * message, the child exiting without one, or a timeout (which also stops it).
 */

export type SpawnedShuttle =
    | { kind: 'started'; pid: number }
    | { kind: 'refused'; reason: string; error: string }
    | { kind: 'failed'; error: string };

export interface SpawnShuttleOptions {
    /** The standalone Node runtime — never Electron's binary (§3.2). */
    nodePath: string;
    /** The shuttle bundle, somewhere plain Node can read it. */
    scriptPath: string;
    env: Record<string, string>;
    /** Where the child's stdout and stderr go. */
    logFile: string;
    /** How long it may take to report. */
    timeoutMs?: number;
    spawn?: typeof nodeSpawn;
}

const DEFAULT_TIMEOUT_MS = 10_000;

export function spawnShuttleProcess(opts: SpawnShuttleOptions): Promise<SpawnedShuttle> {
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const spawn = opts.spawn ?? nodeSpawn;

    return new Promise((resolve) => {
        let settled = false;
        let log: number | null = null;
        const closeLog = () => {
            if (log === null) return;
            try {
                fs.closeSync(log);
            } catch {
                /* already closed */
            }
            log = null;
        };

        try {
            fs.mkdirSync(path.dirname(opts.logFile), { recursive: true });
            log = fs.openSync(opts.logFile, 'a');
        } catch (e) {
            resolve({ kind: 'failed', error: `Cannot open the MCP shuttle log ${opts.logFile}: ${(e as Error).message}` });
            return;
        }

        let child: ReturnType<typeof nodeSpawn>;
        try {
            child = spawn(opts.nodePath, [opts.scriptPath], {
                detached: true,
                stdio: ['ignore', log, log, 'ipc'],
                env: opts.env,
                windowsHide: true,
            });
        } catch (e) {
            closeLog();
            resolve({ kind: 'failed', error: `Could not start the MCP shuttle: ${(e as Error).message}` });
            return;
        }

        const settle = (outcome: SpawnedShuttle) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            closeLog();
            child.removeAllListeners('message');
            if (child.connected) {
                try {
                    child.disconnect();
                } catch {
                    /* the child disconnected first */
                }
            }
            // Nothing here holds the child any longer; it lives or ends on its own.
            child.unref();
            resolve(outcome);
        };

        const timer = setTimeout(() => {
            try {
                child.kill();
            } catch {
                /* already gone */
            }
            settle({ kind: 'failed', error: `The MCP shuttle did not report within ${timeoutMs}ms; see ${opts.logFile}.` });
        }, timeoutMs);

        child.on('message', (raw) => {
            const event = raw as Partial<ShuttleEvent> | null;
            if (!event || typeof event !== 'object') return;
            if (event.event === 'started' && typeof event.pid === 'number') {
                settle({ kind: 'started', pid: event.pid });
            } else if (event.event === 'refused') {
                settle({ kind: 'refused', reason: String(event.reason), error: String(event.error) });
            } else if (event.event === 'invalid') {
                settle({ kind: 'failed', error: `The MCP shuttle rejected its configuration: ${String(event.error)}` });
            }
        });
        child.once('error', (e) => {
            settle({ kind: 'failed', error: `Could not start the MCP shuttle: ${e.message}` });
        });
        child.once('exit', (code, signal) => {
            settle({
                kind: 'failed',
                error: `The MCP shuttle exited (${signal ?? `code ${code}`}) before reporting; see ${opts.logFile}.`,
            });
        });
    });
}
