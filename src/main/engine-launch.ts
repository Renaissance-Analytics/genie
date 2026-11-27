import { winLauncherPath } from './win-launcher.js';
import { createHash } from 'node:crypto';
import { execFile, spawn as spawnChild } from 'node:child_process';
import { closeSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { connect } from 'node:net';
import { join } from 'node:path';
import { ENGINE_PROTOCOL, parseHostRecord, type HostRecord } from '../core/engine-protocol.js';
import { lineTransport, type LineTransport } from '../core/line-transport.js';
/**
 * THE CLIENT LINKS TO THE HOST THAT IS RUNNING, AND NEVER STARTS OR REPLACES ONE (Tynn #1058 L4; the host split, phase 1).
 *
 * At boot, and again whenever the link drops, the window reads `<runtime>/host.json`: a live host of this engine protocol is
 * ADOPTED, whatever its build (the launcher decides which host runs; a host outside the support window is answered
 * update-only by the protocol). With no live host the answer is `null` and the window shows the host directory
 * (core/host-directory.ts): only the launcher starts a host (`launcher.ensureHost`). The single-app install's own start,
 * for a process no launcher started, is quarantined in legacy-host-start.ts until the bridge (L9).
 *
 * Every step is a port, so the decision is tested without a process.
 */

export interface EngineLaunchPorts {
    readonly runtimeDir: string;
    readonly alive?: (pid: number) => boolean;
    readonly readFile?: (file: string) => string | null;
    readonly connectTo?: (endpoint: string) => Promise<LineTransport>;
    readonly log?: (line: string) => void;
}


export interface EngineLink {
    readonly transport: LineTransport;
    readonly token: string;
    readonly record: HostRecord;
    readonly how: 'adopted' | 'started' | 'replaced';
}

export function pidAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return (error as NodeJS.ErrnoException).code === 'EPERM';
    }
}

function readOrNull(file: string): string | null {
    try { return readFileSync(file, 'utf8'); } catch { return null; }
}

export function connectSocket(endpoint: string): Promise<LineTransport> {
    return new Promise((resolve, reject) => {
        const socket = connect(endpoint);
        socket.once('connect', () => { socket.off('error', reject); resolve(lineTransport(socket)); });
        socket.once('error', reject);
    });
}


/**
 * genie-launch.exe's `pipe-owner-only` on genie-host's own pipe (Tynn #398; host-pipe-acl.ts): a protected DACL, its
 * user and SYSTEM. ASYNCHRONOUS, like every launcher call. Resolves to the descriptor read back (SDDL); rejects with the
 * launcher's reason. `null` launcher = not built here (a dev machine with no MSVC), said by the caller.
 */
export function restrictPipeWithLauncher(endpoint: string, launcher: string | null = winLauncherPath()): Promise<string> | null {
    if (launcher === null) return null;
    return new Promise<string>((resolve, reject) => {
        execFile(launcher, ['pipe-owner-only', endpoint], { windowsHide: true, encoding: 'utf8', timeout: 15_000 }, (error, stdout, stderr) => {
            if (error) reject(new Error(String(stderr).trim() || error.message));
            else resolve(String(stdout).trim());
        });
    });
}

/**
 * Link to the host that is running, or to nothing: never start one, never replace one. For a client that isn't the window
 * (the Genie browser's process): another build's host is the window's to replace, whichever client asks.
 */
export async function linkToRunningHost(ports: Pick<EngineLaunchPorts, 'runtimeDir' | 'alive' | 'readFile' | 'connectTo'>): Promise<EngineLink | null> {
    const read = ports.readFile ?? readOrNull;
    const record = parseHostRecord(read(join(ports.runtimeDir, 'host.json')));
    if (record === null || record.protocol !== ENGINE_PROTOCOL || !(ports.alive ?? pidAlive)(record.pid)) return null;
    const token = read(join(ports.runtimeDir, 'host.token'));
    if (token === null) return null;
    try {
        return { transport: await (ports.connectTo ?? connectSocket)(record.endpoint), token: token.trim(), record, how: 'adopted' };
    } catch {
        return null;
    }
}

/** The Genie browser's process, detached: it must outlive the window, and is no child of the host's to end. A real Electron, so not as Node. */
export function spawnBrowserProcess(launch: { readonly file: string; readonly args: readonly string[] }, ports: { readonly logsDir: string; readonly env: NodeJS.ProcessEnv }): number | null {
    mkdirSync(ports.logsDir, { recursive: true });
    const out = openSync(join(ports.logsDir, 'genie-browser.log'), 'a');
    const env = { ...ports.env };
    delete env['ELECTRON_RUN_AS_NODE'];
    try {
        const child = spawnChild(launch.file, [...launch.args], { detached: true, windowsHide: false, stdio: ['ignore', out, out], env });
        child.on('error', () => {});
        child.unref();
        return child.pid ?? null;
    } finally {
        closeSync(out);
    }
}

/**
 * THE UPDATER HELPER (P5b), started by genie-host: Genie's own executable in its `--updater` mode, a real Electron (not as
 * Node), DETACHED. Measured on Windows: a host's non-detached children die with it (libuv's kill-on-close job), and an
 * install has the host exit before the helper runs the installer. Its output goes to `logs/genie-updater.log`.
 */
export function spawnUpdaterProcess(launch: { readonly file: string; readonly args: readonly string[] }, ports: { readonly logsDir: string; readonly env: NodeJS.ProcessEnv }, spawn: typeof spawnChild = spawnChild): number | null {
    mkdirSync(ports.logsDir, { recursive: true });
    const out = openSync(join(ports.logsDir, 'genie-updater.log'), 'a');
    const env = { ...ports.env };
    delete env['ELECTRON_RUN_AS_NODE'];
    try {
        const child = spawn(launch.file, [...launch.args], { detached: true, windowsHide: true, stdio: ['ignore', out, out], env });
        child.on('error', () => {});
        child.unref();
        return child.pid ?? null;
    } finally {
        closeSync(out);
    }
}

/** Genie's window again, after an install that did not happen (P5b): detached, a real Electron, nothing held of the caller. */
export function spawnGenieWindow(launch: { readonly file: string; readonly args: readonly string[] }, env: NodeJS.ProcessEnv, spawn: typeof spawnChild = spawnChild): number | null {
    const own = { ...env };
    delete own['ELECTRON_RUN_AS_NODE'];
    const child = spawn(launch.file, [...launch.args], { detached: true, windowsHide: false, stdio: 'ignore', env: own });
    child.on('error', () => {});
    // HOW IT ENDS, KEPT (Tynn issue #711): the one process whose exit code and signal this process can see is its own child.
    const pid = child.pid;
    if (typeof pid === 'number') child.on('exit', (code: number | null, signal: NodeJS.Signals | null) => { keepWindowExit(pid, code, signal); });
    child.unref();
    return child.pid ?? null;
}

/** The exits of the windows this process started, newest kept, by pid. */
const windowExits = new Map<number, { code: number | null; signal: string | null }>();
const WINDOW_EXITS_KEPT = 32;

function keepWindowExit(pid: number, code: number | null, signal: string | null): void {
    windowExits.delete(pid);
    windowExits.set(pid, { code, signal });
    while (windowExits.size > WINDOW_EXITS_KEPT) windowExits.delete(windowExits.keys().next().value as number);
}

/** How a window this process started ended (its exit code and signal), or `null`: still running, or not started here. */
export function windowExitOf(pid: number): { code: number | null; signal: string | null } | null {
    return windowExits.get(pid) ?? null;
}

/**
 * THE CLIENT'S LINK (Tynn #1058 L4): the live host of this engine protocol, adopted whatever its build, or `null`. Nothing is
 * started, asked to stop or ended here: a host that does not answer yet is tried again by the caller (agent-engine.ts).
 */
export async function linkToHost(ports: EngineLaunchPorts): Promise<EngineLink | null> {
    const read = ports.readFile ?? readOrNull;
    const log = ports.log ?? (() => {});
    const record = parseHostRecord(read(join(ports.runtimeDir, 'host.json')));
    if (record === null || !(ports.alive ?? pidAlive)(record.pid)) { log('no host is running: the host directory is shown, and nothing is started here'); return null; }
    if (record.protocol !== ENGINE_PROTOCOL) { log(`host pid=${record.pid} speaks engine protocol ${record.protocol}, this client ${ENGINE_PROTOCOL}: not linked, never replaced`); return null; }
    const token = read(join(ports.runtimeDir, 'host.token'));
    if (token === null) { log(`host pid=${record.pid} left no token`); return null; }
    try {
        const transport = await (ports.connectTo ?? connectSocket)(record.endpoint);
        log(`host adopted pid=${record.pid} build=${record.build}`);
        return { transport, token: token.trim(), record, how: 'adopted' };
    } catch (error) {
        log(`host pid=${record.pid} did not answer (${error instanceof Error ? error.message : String(error)}); not ended, tried again later`);
        return null;
    }
}


/**
 * THE HOST'S BUILD: the app version and a hash of the host bundle's bytes. A window adopts only a host of exactly this
 * build; a rebuilt host bundle (a dev build, an update) is a different host and replaces the running one gracefully.
 */
export function hostBuild(version: string, hostScript: string): string {
    try {
        return `${version}+${createHash('sha256').update(readFileSync(hostScript)).digest('hex').slice(0, 12)}`;
    } catch {
        return version;
    }
}
