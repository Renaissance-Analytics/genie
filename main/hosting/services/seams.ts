import fsp from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type {
    CommandRunner,
    HostedProcessHandle,
    PortProbe,
    ProcessSpawner,
    ServiceFs,
    SpawnOptions,
} from './types';

/**
 * The real I/O behind the service runtimes' injected seams.
 *
 * Kept in one module rather than inside each runtime so a test substitutes
 * fakes without ever loading `node:net` or `node:child_process`, and so the two
 * spawn-hardening rules that matter are written down once:
 *
 *   - never `shell: true` — every argument here contains a user-supplied path,
 *     and a shell would make a directory name with a space or an ampersand into
 *     argv injection;
 *   - always `windowsHide` — a managed background service must not flash a
 *     console window, which is what makes an Electron app look broken.
 */

/** Long-lived servers (`postgres`, `GarnetServer`). */
export const defaultServiceSpawner: ProcessSpawner = {
    spawn(command: string, args: string[], opts: SpawnOptions): HostedProcessHandle {
        const child = spawn(command, args, {
            cwd: opts.cwd,
            env: { ...process.env, ...opts.env },
            shell: false,
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        // Postgres logs to stderr and Garnet to stdout; both are "the server
        // log" as far as readiness detection and the Site Manager care.
        child.stderr?.on('data', (chunk) => opts.onStderr?.(String(chunk)));
        child.stdout?.on('data', (chunk) => opts.onStderr?.(String(chunk)));
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

/** One-shot tools (`initdb`, `createdb`, `pg_ctl`). */
export const defaultCommandRunner: CommandRunner = {
    run(command, args, opts) {
        return new Promise((resolve) => {
            const child = spawn(command, args, {
                cwd: opts.cwd,
                env: { ...process.env, ...opts.env },
                shell: false,
                windowsHide: true,
                stdio: ['ignore', 'pipe', 'pipe'],
            });
            let stdout = '';
            let stderr = '';
            child.stdout?.on('data', (c) => {
                stdout = (stdout + String(c)).slice(-4000);
            });
            child.stderr?.on('data', (c) => {
                stderr = (stderr + String(c)).slice(-4000);
            });
            // An `error` (the executable is missing) resolves rather than
            // rejects: callers treat a non-zero exit as a failure with a
            // message, and "could not be spawned" is that same case.
            child.on('error', (e) => resolve({ code: null, stdout, stderr: String(e) }));
            child.on('close', (code) => resolve({ code, stdout, stderr }));
        });
    },
};

export const defaultServiceFs: ServiceFs = {
    async exists(p) {
        try {
            await fsp.access(p);
            return true;
        } catch {
            return false;
        }
    },
    async mkdir(p) {
        await fsp.mkdir(p, { recursive: true });
    },
    async write(filePath, contents) {
        await fsp.mkdir(path.dirname(filePath), { recursive: true });
        // 0600: this is how the Postgres password file is written, and it must
        // not be readable by other accounts on a shared machine. `initdb` also
        // refuses a data directory with group/world permissions.
        await fsp.writeFile(filePath, contents, { encoding: 'utf8', mode: 0o600 });
    },
    async read(filePath) {
        try {
            return await fsp.readFile(filePath, 'utf8');
        } catch {
            return null;
        }
    },
    async remove(p) {
        await fsp.rm(p, { recursive: true, force: true });
    },
};

/** How long to wait before deciding nothing is listening. Short: this only ever
 *  probes loopback, where a live listener answers immediately. */
const PROBE_TIMEOUT_MS = 400;

export const defaultPortProbe: PortProbe = {
    inUse(host, port) {
        return new Promise((resolve) => {
            const socket = new net.Socket();
            const done = (result: boolean) => {
                socket.destroy();
                resolve(result);
            };
            socket.setTimeout(PROBE_TIMEOUT_MS);
            socket.once('connect', () => done(true));
            socket.once('timeout', () => done(false));
            socket.once('error', () => done(false));
            socket.connect(port, host);
        });
    },
};
