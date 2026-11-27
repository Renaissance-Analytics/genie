/**
 * THE SINGLE-APP INSTALL'S OWN HOST START: QUARANTINED, AND REMOVED BY L9 (the bridge). Tynn #1058 L4.
 *
 * Under the launcher a client never starts or replaces a host: it links to the host the launcher gives it, or it shows the
 * host directory (engine-launch.ts `linkToHost`, core/host-directory.ts). This module is what is left of the window that
 * started its own host, for a process NO launcher started: a dev or CI tree run as `electron .`, and the single-app
 * install (one Genie.exe / AppImage, electron-updater) until the bridge release moves every install to the launcher.
 *
 * It keeps today's behaviour exactly (adopt, replace a host of another build, start one and wait for it, Restart Genie's
 * host), so a single-app update still brings the host to the new build. main.ts reaches it in one place, behind
 * `launched === null`; nothing else imports it (test/client-never-starts-host.test.ts holds that).
 *
 * REMOVAL: L9 (the bridge and the migration) deletes this file with `--updater` and `materializeHostRuntime`.
 */
import { execFile, spawn as spawnChild } from 'node:child_process';
import { closeSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ENGINE_PROTOCOL, hostDecision, parseHostRecord, type HostRecord } from '../core/engine-protocol.js';
import { connectSocket, pidAlive, type EngineLaunchPorts, type EngineLink } from './engine-launch.js';
import { SessionEngineClient } from './session-engine-client.js';
import { winLauncherPath } from './win-launcher.js';

function readOrNull(file: string): string | null {
    try { return readFileSync(file, 'utf8'); } catch { return null; }
}

/** What the single-app window needs to start, replace and wait for its own host. */
export interface LegacyLaunchPorts extends EngineLaunchPorts {
    readonly logsDir: string;
    readonly build: string;
    /** The host script (`dist/main/host.js`) and the runtime that runs it (`process.execPath`). */
    readonly hostScript: string;
    readonly execPath: string;
    readonly genieHome: string;
    readonly env: NodeJS.ProcessEnv;
    readonly spawnHost?: () => number | null | Promise<number | null>;
    /** Ask a host of another build to shut down (through a client that said its token). */
    readonly askShutdown?: (record: HostRecord) => Promise<void>;
    readonly kill?: (pid: number) => void;
    readonly sleep?: (ms: number) => Promise<void>;
    readonly now?: () => number;
    readonly log?: (line: string) => void;
    /**
     * How long a started host has to write its record. Absent (a window starting its own host): no fixed time; the wait
     * ends when the host is ready or when it exits (Tynn #700: a first start on a slow Windows took 20 s).
     */
    readonly startTimeoutMs?: number;
    /** How long it has waited for a host it started, about once a second (Tynn #700). */
    readonly onWaiting?: (elapsedMs: number) => void;
    /** The person's "Restart Genie's host" while it waits (Tynn #700): asked, then answered once the new host is started. */
    readonly restart?: { take(): boolean; settled(outcome: { ok: true } | { ok: false; reason: string }): void };
}

/**
 * How the host is started: Electron's binary as plain Node, on the window's root (#1605: the window's root is
 * `genieRoot()`, so a GENIE_HOME set for the whole app reaches the host unchanged), detached and hidden.
 */
export function hostSpawnSpec(ports: Pick<LegacyLaunchPorts, 'execPath' | 'hostScript' | 'env' | 'genieHome' | 'build'>): { file: string; args: string[]; options: { detached: true; windowsHide: true; env: NodeJS.ProcessEnv } } {
    return {
        file: ports.execPath,
        args: [ports.hostScript],
        options: { detached: true, windowsHide: true, env: { ...ports.env, ELECTRON_RUN_AS_NODE: '1', GENIE_HOME: ports.genieHome, GENIE_HOST_BUILD: ports.build } },
    };
}

/**
 * The host, detached from the window: it must outlive the window's process (a crash, a restart). On Windows through
 * genie-launch.exe (win-launcher.ts, #1628): Node's spawn would hand the host every inheritable handle of the window's —
 * CI measured the first window's DevTools socket held by genie-host after that window was ended — and the launcher gives
 * it only its log and NUL. Where the launcher was not built (a dev machine with no MSVC), Node's spawn, as before.
 */
export async function spawnHostProcess(
    ports: Pick<LegacyLaunchPorts, 'execPath' | 'hostScript' | 'logsDir' | 'env' | 'genieHome' | 'build'>,
    launcher: string | null = winLauncherPath(),
    say: (line: string) => void = () => {},
): Promise<number | null> {
    mkdirSync(ports.logsDir, { recursive: true });
    const spec = hostSpawnSpec(ports);
    if (launcher !== null) {
        // ASYNCHRONOUS, never execFileSync: this runs on window main, which a synchronous child start on Windows holds
        // (#1576/#1595: 4.4 s cold). The launcher prints the host's pid and exits; the host runs on.
        const said = await new Promise<string>((resolve, reject) => {
            execFile(launcher, ['detach', join(ports.logsDir, 'genie-host.log'), spec.file, ...spec.args], { env: spec.options.env, windowsHide: true, encoding: 'utf8', timeout: 20_000 }, (error, stdout) => (error ? reject(error) : resolve(String(stdout))));
        });
        const pid = Number(said.trim());
        say(`host spawn via=genie-launch pid=${Number.isInteger(pid) && pid > 0 ? pid : '-'}`);
        return Number.isInteger(pid) && pid > 0 ? pid : null;
    }
    say(`host spawn via=node-spawn${process.platform === 'win32' ? ' (genie-launch.exe was not found: the host inherits the window\'s handles)' : ''}`);
    const out = openSync(join(ports.logsDir, 'genie-host.log'), 'a');
    try {
        const child = spawnChild(spec.file, spec.args, { ...spec.options, stdio: ['ignore', out, out] });
        child.unref();
        return child.pid ?? null;
    } finally {
        closeSync(out);
    }
}

export async function legacyLinkToHost(ports: LegacyLaunchPorts): Promise<EngineLink> {
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

    const startHost = ports.spawnHost ?? (() => spawnHostProcess(ports, winLauncherPath(), log));
    let pid = await startHost();
    if (pid === null) throw new Error('the host process could not be started');
    log(`host started pid=${pid} build=${ports.build}`);
    // OUR OWN CHILD (Tynn #700): waited for until it is ready or it exits, never given up on at a fixed time while it lives.
    const began = now();
    const until = ports.startTimeoutMs === undefined ? Infinity : began + ports.startTimeoutMs;
    let said = began;
    while (now() < until) {
        // RESTART GENIE'S HOST, pressed in the wait (Tynn #700): this host is ended as a replaced one is, a new one started,
        // and the same wait goes on for the new one.
        if (ports.restart?.take()) {
            const old = pid;
            log(`host pid=${old} restarted by the person after ${Math.round((now() - began) / 1000)} s; ending it`);
            ports.kill?.(old);
            const gone = now() + 10_000;
            while (alive(old) && now() < gone) await sleep(100);
            if (alive(old)) { ports.restart.settled({ ok: false, reason: `Genie’s host (pid ${old}) did not end, so a new one was not started.` }); }
            else {
                const fresh = await startHost();
                if (fresh === null) { ports.restart.settled({ ok: false, reason: 'the host process could not be started' }); throw new Error('the host process could not be started'); }
                pid = fresh;
                log(`host started pid=${pid} build=${ports.build}`);
                ports.restart.settled({ ok: true });
            }
        }
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
        if (now() - said >= 1_000) { said = now(); try { ports.onWaiting?.(said - began); } catch { /* the wait's words never stop the wait */ } }
    }
    throw new Error(`the host did not become ready within ${Math.round((ports.startTimeoutMs ?? 0) / 1000)} s (see logs/genie-host.log)`);
}

const killPid = (pid: number): void => {
    try { process.kill(pid); } catch { /* already gone */ }
};

/**
 * The single-app window's way to its host, for connectAgentEngine's `find`: adopt, replace (a host of another build is
 * told to stop gracefully through its own token, then ended) or start one and wait for it. `null` when none can be had;
 * the window then shows the host directory with why.
 */
export function legacyHostFinder(ports: Omit<LegacyLaunchPorts, 'askShutdown' | 'kill'>, onFailed: (reason: string) => void = () => {}): () => Promise<EngineLink | null> {
    const full: LegacyLaunchPorts = {
        ...ports,
        kill: killPid,
        askShutdown: async (record) => {
            const old = await legacyLinkToHost({ ...ports, build: record.build, spawnHost: () => null, startTimeoutMs: 1 }).catch(() => null);
            if (!old) return;
            const peer = new SessionEngineClient();
            if ((await peer.connect(old.transport, old.token)).ok) await peer.shutdown();
            peer.disconnect();
        },
    };
    return async () => {
        try {
            return await legacyLinkToHost(full);
        } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            ports.log?.(`agent host unavailable: ${reason}`);
            onFailed(reason);
            return null;
        }
    };
}

