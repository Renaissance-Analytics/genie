import { execFile } from 'node:child_process';

/**
 * A command a fixture runs, whose failure says everything the child process knew (genie#1992). node's own message is only
 * "Command failed: <cmd>": a git that exited with nothing on stderr, was killed, or ran out of time all read the same.
 * This one names the exit code, the signal, whether the timeout was what ended it, and what it printed on both streams.
 */
export interface CommandFailure extends Error {
    readonly code: number | string | null;
    readonly signal: NodeJS.Signals | null;
    readonly timedOut: boolean;
    readonly stdout: string;
    readonly stderr: string;
}

export interface CommandOptions {
    /** Ends the command after this long, and says so. Absent: it may take as long as it takes. */
    readonly timeoutMs?: number;
}

const shown = (text: string): string => (text.trim() === '' ? '(empty)' : JSON.stringify(text.length > 2000 ? `${text.slice(0, 2000)}…` : text));

export function runCommand(file: string, args: readonly string[], options: CommandOptions = {}): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
        const started = Date.now();
        execFile(file, [...args], { encoding: 'utf8', ...(options.timeoutMs !== undefined ? { timeout: options.timeoutMs } : {}) }, (error, stdout, stderr) => {
            if (error === null) { resolve({ stdout, stderr }); return; }
            const e = error as NodeJS.ErrnoException & { killed?: boolean; signal?: NodeJS.Signals | null; code?: number | string };
            const elapsed = Date.now() - started;
            const timedOut = options.timeoutMs !== undefined && e.killed === true && elapsed >= options.timeoutMs - 50;
            const code = e.code ?? null;
            const detail = [
                `${file} ${args.join(' ')}`,
                `exit code: ${code === null ? '(none)' : String(code)}`,
                `signal: ${e.signal ?? '(none)'}`,
                `timed out: ${timedOut ? `yes, after ${options.timeoutMs} ms` : `no (ran ${elapsed} ms)`}`,
                `stdout: ${shown(stdout)}`,
                `stderr: ${shown(stderr)}`,
            ].join('\n  ');
            reject(Object.assign(new Error(`Command failed\n  ${detail}`), { code, signal: e.signal ?? null, timedOut, stdout, stderr }));
        });
    });
}
