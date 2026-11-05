import { createHash } from 'node:crypto';
import { spawn as spawnChild } from 'node:child_process';
import { closeSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { connect } from 'node:net';
import { join } from 'node:path';
import { ENGINE_PROTOCOL, hostDecision, parseHostRecord, type HostRecord } from '../core/engine-protocol.js';
import { lineTransport, type LineTransport } from '../core/line-transport.js';

/**
 * FIND, ADOPT, REPLACE OR START THE HOST (the window's side; the host split, phase 1).
 *
 * At boot, and again whenever the link drops, the window reads `<runtime>/host.json` and decides (core/engine-protocol.ts
 * `hostDecision`):
 *  - a live host of this protocol and build is ADOPTED — its agents kept running while the window was away;
 *  - a live host of another build is REPLACED: asked to shut down gracefully, waited for (bounded), then ended by pid;
 *  - otherwise a new host is STARTED, detached, on Electron's binary as Node, its output in `<genieHome>/logs`.
 *
 * Every step is a port, so the decision and its order are tested without a process.
 */

export interface EngineLaunchPorts {
    readonly runtimeDir: string;
    readonly logsDir: string;
    readonly build: string;
    /** The host script (`dist/main/host.js`) and the runtime that runs it (`process.execPath`). */
    readonly hostScript: string;
    readonly execPath: string;
    readonly genieHome: string;
    readonly env: NodeJS.ProcessEnv;
    readonly alive?: (pid: number) => boolean;
    readonly readFile?: (file: string) => string | null;
    readonly spawnHost?: () => number | null;
    readonly connectTo?: (endpoint: string) => Promise<LineTransport>;
    /** Ask a host of another build to shut down (through a client that said its token). */
    readonly askShutdown?: (record: HostRecord) => Promise<void>;
    readonly kill?: (pid: number) => void;
    readonly sleep?: (ms: number) => Promise<void>;
    readonly now?: () => number;
    readonly log?: (line: string) => void;
    /** How long a started host has to write its record. Default 20 s (the first start builds the Windows supervisor). */
    readonly startTimeoutMs?: number;
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

/** The host, detached from the window: it must outlive the window's process (a crash, a restart). */
export function spawnHostProcess(ports: Pick<EngineLaunchPorts, 'execPath' | 'hostScript' | 'logsDir' | 'env' | 'genieHome' | 'build'>): number | null {
    mkdirSync(ports.logsDir, { recursive: true });
    const out = openSync(join(ports.logsDir, 'genie-host.log'), 'a');
    try {
        const child = spawnChild(ports.execPath, [ports.hostScript], {
            detached: true,
            windowsHide: true,
            stdio: ['ignore', out, out],
            env: { ...ports.env, ELECTRON_RUN_AS_NODE: '1', GENIE_HOME: ports.genieHome, GENIE_HOST_BUILD: ports.build },
        });
        child.unref();
        return child.pid ?? null;
    } finally {
        closeSync(out);
    }
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
export function spawnBrowserProcess(launch: { readonly file: string; readonly args: readonly string[] }, ports: Pick<EngineLaunchPorts, 'logsDir' | 'env'>): number | null {
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
export function spawnUpdaterProcess(launch: { readonly file: string; readonly args: readonly string[] }, ports: Pick<EngineLaunchPorts, 'logsDir' | 'env'>, spawn: typeof spawnChild = spawnChild): number | null {
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
    child.unref();
    return child.pid ?? null;
}

export async function linkToHost(ports: EngineLaunchPorts): Promise<EngineLink> {
    const alive = ports.alive ?? pidAlive;
    const read = ports.readFile ?? readOrNull;
    const sleep = ports.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const now = ports.now ?? Date.now;
    const log = ports.log ?? (() => {});
    const recordFile = join(ports.runtimeDir, 'host.json');
    const tokenFile = join(ports.runtimeDir, 'host.token');
    const connectTo = ports.connectTo ?? connectSocket;

    const adopt = async (record: HostRecord, how: EngineLink['how']): Promise<EngineLink> => {
        const token = read(tokenFile);
        if (token === null) throw new Error('the host left no token');
        const transport = await connectTo(record.endpoint);
        return { transport, token: token.trim(), record, how };
    };

    const decision = hostDecision(parseHostRecord(read(recordFile)), alive, { protocol: ENGINE_PROTOCOL, build: ports.build });
    if (decision.kind === 'adopt') {
        try {
            const link = await adopt(decision.record, 'adopted');
            log(`host adopted pid=${decision.record.pid} build=${decision.record.build}`);
            return link;
        } catch (error) {
            // Alive by pid and not answering: a hung or half-dead host. Ended, then started fresh.
            log(`host pid=${decision.record.pid} did not answer (${error instanceof Error ? error.message : String(error)}); replacing it`);
            ports.kill?.(decision.record.pid);
        }
    }
    let how: EngineLink['how'] = 'started';
    if (decision.kind === 'replace') {
        how = 'replaced';
        log(`host pid=${decision.record.pid} is ${decision.why}; asking it to shut down`);
        await (ports.askShutdown?.(decision.record) ?? Promise.resolve()).catch(() => undefined);
        const until = now() + 15_000;
        while (alive(decision.record.pid) && now() < until) await sleep(100);
        if (alive(decision.record.pid)) { log(`host pid=${decision.record.pid} did not exit; ending it`); ports.kill?.(decision.record.pid); }
    }

    const pid = (ports.spawnHost ?? (() => spawnHostProcess(ports)))();
    if (pid === null) throw new Error('the host process could not be started');
    log(`host started pid=${pid} build=${ports.build}`);
    const until = now() + (ports.startTimeoutMs ?? 20_000);
    while (now() < until) {
        const record = parseHostRecord(read(recordFile));
        // Its own record: another host winning the endpoint race is adopted instead (this one exits on its own).
        if (record !== null && alive(record.pid) && record.build === ports.build && record.protocol === ENGINE_PROTOCOL) {
            try {
                return await adopt(record, record.pid === pid ? how : 'adopted');
            } catch {
                // Written, not yet answering: the next look.
            }
        }
        if (!alive(pid) && (record === null || record.pid === pid)) throw new Error('the host process exited before it was ready (see logs/genie-host.log)');
        await sleep(100);
    }
    throw new Error(`the host did not become ready within ${Math.round((ports.startTimeoutMs ?? 20_000) / 1000)} s (see logs/genie-host.log)`);
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
