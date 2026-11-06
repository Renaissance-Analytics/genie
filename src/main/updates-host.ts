import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { channelFrom, type UpdateChannel } from '../core/update-channel.js';
import type { AgentId } from '../core/identity.js';
import { recordShutdown, recordThenStopAll } from './shutdown-record.js';
import { AUTO_CHECK, UpdateHost, type DrainAgentsPort, type UpdateHostOptions, type UpdateState, type UpdaterPort } from './updater.js';

/**
 * THE UPDATER IN GENIE-HOST (the host split, P5b; plan "P5b build spec").
 *
 * `UpdateHost` — the state machine, the channel, the schedule, the changelog, the drain and the teardown report — runs
 * HERE, unchanged in its rules. Its `UpdaterPort` is a client of the UPDATER HELPER: Genie's own executable started by this
 * host in its `--updater` mode (updater-process.ts), with no window, its own user data and its own token hello. electron-updater
 * needs Electron's `app`, which this host (Electron as Node) does not have; the helper makes the library's calls and nothing
 * else. It is started when a check, a download or an install needs it, and leaves when idle.
 *
 * - The window holds a replica (updates-replica.ts), fed on LOCAL links only, and sends the person's check, download,
 *   install and channel as calls (`engine.updates`).
 * - With no window open this host still checks on its schedule, and downloads what it finds. It never installs by itself:
 *   an install is a person's action from a window (or the tray, which lives in the window's process).
 * - THE INSTALL ORDER: the helper makes the install ready (nothing stopped yet), the agents are drained, what this host
 *   hosts is stopped (P5a.3's order, containers stay), the install directory's teardown scan runs (sparing this host, the
 *   helper and the window that asked), the helper is handed the install, and this host exits. The helper then waits for
 *   every Genie process that maps the install to be gone — bounded, said in words if not — before it runs the installer.
 */

export interface UpdaterConfig {
    readonly allowPrerelease: boolean;
    readonly autoDownload: boolean;
}

/** What the helper waits for before it runs the installer: these pids gone, and nothing else running from the install. */
export interface InstallWait {
    readonly pids: readonly number[];
    readonly installDir: string;
    readonly boundMs: number;
}

export type UpdaterOp = 'check' | 'download' | 'prepare' | 'install';

/** Host → helper, on `updater.event`. */
export type UpdaterEvent =
    | { readonly kind: 'configure'; readonly config: UpdaterConfig }
    | { readonly kind: 'request'; readonly id: number; readonly op: UpdaterOp; readonly wait?: InstallWait };

/** How to start Genie's own executable in its updater mode: the window knows its install (and a dev run's app path). */
export interface HelperLaunch {
    readonly file: string;
    readonly args: readonly string[];
}

/** The hello label the helper says: its link is the helper's, never a window's. */
export const UPDATER_HELPER_LABEL = 'genie updater';

/** How long a started helper has to link before what needed it is told, in words. */
export const HELPER_PATIENCE_MS = 30_000;

/** How long the helper waits for every Genie process to be gone before it gives up the install (and says so). */
export const INSTALL_WAIT_MS = 30_000;

export const NO_WINDOW_INSTALL = 'An update is installed from a Genie window or its tray, by the person; never with no window open.';

export interface UpdatesCaller {
    /** A local window asked (its link, never the helper's or a remote's own). */
    readonly window: boolean;
}

export interface UpdatesServiceOptions {
    /** `UpdateHost`'s options but its port, its quit delay and the pids it spares, which this service owns. */
    readonly host: Omit<UpdateHostOptions, 'port' | 'defer' | 'spare'>;
    /** Start the helper process (engine-launch.ts `spawnUpdaterProcess`, detached). */
    readonly startHelper: (launch: HelperLaunch) => void;
    /** The helper's launch until a window says its own (a packaged install: this executable, `--updater`). */
    readonly defaultLaunch: HelperLaunch;
    readonly windowConnected: () => boolean;
    /** This host's own end, after the helper has the install. */
    readonly exit: () => void;
    readonly helperPatienceMs?: number;
    readonly installWaitMs?: number;
    readonly defer?: (fn: () => void, ms: number) => void;
    readonly log?: (line: string) => void;
    /** A failed install's record, read at this host's start (`readUpdateFailed`): told to the first local window, once. */
    readonly failed?: UpdateFailedRecord | null;
    /** Clear the record once a window has been told. */
    readonly clearFailed?: () => void;
    /** The helper could not be handed the install (it went): record why and start Genie again. */
    readonly handOverFailed?: (reason: string, launch: HelperLaunch) => void;
    /** Why this host has no updater (P10.1d: plain Node, its image updated by its deployment). Absent = it has one. */
    readonly unavailable?: string;
}

/** Why the last install did not happen, for the next window (`<home>/runtime/update-failed.json`). */
export interface UpdateFailedRecord {
    readonly at: number;
    readonly reason: string;
    /** Where the updater's own log is. */
    readonly log: string;
}

const failedFile = (home: string): string => join(home, 'runtime', 'update-failed.json');

export function readUpdateFailed(home: string): UpdateFailedRecord | null {
    try {
        const raw = JSON.parse(readFileSync(failedFile(home), 'utf8')) as Partial<UpdateFailedRecord>;
        if (typeof raw.at !== 'number' || typeof raw.reason !== 'string' || typeof raw.log !== 'string') return null;
        return { at: raw.at, reason: raw.reason, log: raw.log };
    } catch {
        return null;
    }
}

export function writeUpdateFailed(home: string, record: UpdateFailedRecord): void {
    mkdirSync(join(home, 'runtime'), { recursive: true });
    writeFileSync(failedFile(home), JSON.stringify(record));
}

export function clearUpdateFailed(home: string): void {
    rmSync(failedFile(home), { force: true });
}

/** How the updater helper is started: the published launch. */
export function helperLaunch(launch: HelperLaunch): HelperLaunch {
    return { file: launch.file, args: [...launch.args] };
}
/**
 * How to start Genie again after an install that did not happen: the executable still installed (on Linux the AppImage
 * file itself, whose mount may be gone), the window's own switches and a dev run's app path — never the updater mode.
 */
export function relaunchSpec(launch: HelperLaunch, env: NodeJS.ProcessEnv): HelperLaunch {
    const appImage = env['APPIMAGE'];
    return { file: appImage && appImage.length > 0 ? appImage : launch.file, args: launch.args.filter((a) => a !== '--updater') };
}

/** The helper answered an install with a refusal: it records why and starts Genie again itself. */
export class HelperRefusal extends Error {}

interface LinkedHelper {
    readonly connection: string;
    readonly pid: number;
    readonly send: (event: UpdaterEvent) => void;
}

interface Pending {
    readonly resolve: (value: unknown) => void;
    readonly reject: (error: Error) => void;
    readonly progress?: (percent: number) => void;
}

function isLaunch(value: unknown): value is HelperLaunch {
    if (typeof value !== 'object' || value === null) return false;
    const v = value as Partial<HelperLaunch>;
    return typeof v.file === 'string' && v.file.length > 0 && Array.isArray(v.args) && v.args.every((a) => typeof a === 'string');
}

export class UpdatesService {
    readonly #options: UpdatesServiceOptions;
    readonly #host: UpdateHost;
    readonly #listeners = new Set<(state: UpdateState) => void>();
    readonly #pending = new Map<number, Pending>();
    #helper: LinkedHelper | null = null;
    #waiting: Array<{ resolve: (helper: LinkedHelper) => void; reject: (error: Error) => void }> = [];
    #launch: HelperLaunch;
    #config: UpdaterConfig = { allowPrerelease: false, autoDownload: false };
    #nextId = 1;
    #windowPids: number[] = [];
    #failed: UpdateFailedRecord | null;

    constructor(options: UpdatesServiceOptions) {
        this.#options = options;
        this.#failed = options.failed ?? null;
        this.#launch = options.defaultLaunch;
        const port: UpdaterPort = {
            configure: (config) => {
                this.#config = { allowPrerelease: config.allowPrerelease, autoDownload: config.autoDownload };
                // Hot-swapped: a running helper is told now; one started later is told when it links.
                this.#helper?.send({ kind: 'configure', config: this.#config });
            },
            check: async () => (await this.#request('check')) as { version: string } | null,
            download: async (onProgress) => { await this.#request('download', onProgress); },
            prepareInstall: async () => { await this.#request('prepare'); },
            quitAndInstall: () => { void this.#handOver(); },
        };
        this.#host = new UpdateHost({
            ...options.host,
            port,
            spare: () => [...(this.#helper ? [this.#helper.pid] : []), ...this.#windowPids],
            ...(options.defer ? { defer: options.defer } : {}),
        });
        this.#host.onChange((state) => { for (const l of [...this.#listeners]) l(state); });
    }

    get updates(): UpdateHost {
        return this.#host;
    }

    /** How Genie is started, as the last window published it (else this host's default): what a relaunch starts (relaunchSpec). */
    launchSpec(): HelperLaunch {
        return { file: this.#launch.file, args: [...this.#launch.args] };
    }

    dump(): UpdateState {
        return this.#host.state();
    }

    onEvent(listener: (state: UpdateState) => void): () => void {
        this.#listeners.add(listener);
        return () => { this.#listeners.delete(listener); };
    }

    setChannel(channel: UpdateChannel): void {
        this.#host.setChannel(channel);
    }

    /** Why the last install did not happen, for the first local window after it: taken once, and the record cleared. */
    takeFailed(): UpdateFailedRecord | null {
        const failed = this.#failed;
        if (failed === null) return null;
        this.#failed = null;
        try { this.#options.clearFailed?.(); } catch (error) { this.#log(`updater: the failed-install record could not be cleared: ${error instanceof Error ? error.message : String(error)}`); }
        return failed;
    }

    /** A window's (or, through it, an owner's remote) call. */
    async call(method: string, args: readonly unknown[], caller: UpdatesCaller): Promise<unknown> {
        switch (method) {
            case 'state':
                return this.#host.state();
            case 'check':
                if (this.#options.unavailable !== undefined) throw new Error(this.#options.unavailable);
                return this.#host.check();
            case 'download':
                if (this.#options.unavailable !== undefined) throw new Error(this.#options.unavailable);
                return this.#host.download();
            case 'notes':
                return this.#host.refreshNotes();
            case 'lastInstall':
                return this.#host.lastInstall();
            case 'setChannel':
                this.setChannel(channelFrom(args[0]));
                return null;
            case 'launch':
                if (!isLaunch(args[0])) throw new Error('that is not how to start Genie’s updater');
                this.#launch = { file: args[0].file, args: [...args[0].args] };
                return null;
            case 'install': {
                if (this.#options.unavailable !== undefined) throw new Error(this.#options.unavailable);
                if (!caller.window) throw new Error(NO_WINDOW_INSTALL);
                const pid = args[0];
                this.#windowPids = typeof pid === 'number' && Number.isInteger(pid) && pid > 0 ? [pid] : [];
                return this.#host.install();
            }
            default:
                throw new Error(`Genie’s updater has no ${method}`);
        }
    }

    /**
     * The host's own checks (`AUTO_CHECK`), window or no window. What a check finds is downloaded on the schedule only when
     * the update CHANNEL's own `autoDownload` says so (updaterConfigFor); otherwise downloading stays a person's click.
     */
    startAutoCheck(schedule: (fn: () => void, ms: number) => () => void, timing: { initialMs: number; intervalMs: number } = AUTO_CHECK): () => void {
        // No updater on this host (P10.1d): no clock, so no helper is ever started by one.
        if (this.#options.unavailable !== undefined) return () => {};
        const off = this.#host.onChange((state) => {
            if (state.phase === 'available' && this.#config.autoDownload) queueMicrotask(() => { void this.#host.download(); });
        });
        const stop = this.#host.startAutoCheck(schedule, timing);
        return () => { off(); stop(); };
    }

    /** The helper said its hello and `register`: it gets the channel of now, and what waited for it goes on. */
    helperLinked(connection: string, pid: number, send: (event: UpdaterEvent) => void): { config: UpdaterConfig } {
        const helper: LinkedHelper = { connection, pid, send };
        this.#helper = helper;
        this.#log(`updater: linked pid=${pid}`);
        for (const w of this.#waiting.splice(0)) w.resolve(helper);
        return { config: this.#config };
    }

    /** The helper's answers: `reply [id, ok, value]` and `progress [id, percent]`, from the linked helper only. */
    helperCall(method: string, args: readonly unknown[], connection: string): unknown {
        if (this.#helper?.connection !== connection) throw new Error('only the linked updater answers');
        const pending = this.#pending.get(Number(args[0]));
        if (method === 'progress') {
            if (pending && typeof args[1] === 'number') pending.progress?.(args[1]);
            return null;
        }
        if (method !== 'reply') throw new Error(`the updater link has no ${method}`);
        if (!pending) return null;
        this.#pending.delete(Number(args[0]));
        if (args[1] === true) pending.resolve(args[2] ?? null);
        else pending.reject(new HelperRefusal(typeof args[2] === 'string' ? args[2] : 'Genie’s updater failed'));
        return null;
    }

    helperDropped(connection: string): void {
        if (this.#helper?.connection !== connection) return;
        this.#helper = null;
        this.#log('updater: its link closed');
        for (const p of this.#pending.values()) p.reject(new Error('Genie’s updater went away before it answered'));
        this.#pending.clear();
    }

    #log(line: string): void {
        this.#options.log?.(line);
    }

    #ensureHelper(): Promise<LinkedHelper> {
        if (this.#helper) return Promise.resolve(this.#helper);
        // Whatever asks, a host with no updater launches no helper (P10.1d).
        if (this.#options.unavailable !== undefined) return Promise.reject(new Error(this.#options.unavailable));
        return new Promise((resolve, reject) => {
            const patience = this.#options.helperPatienceMs ?? HELPER_PATIENCE_MS;
            const waiter = {
                resolve: (helper: LinkedHelper) => { clearTimeout(timer); resolve(helper); },
                reject,
            };
            const timer = setTimeout(() => {
                this.#waiting = this.#waiting.filter((w) => w !== waiter);
                reject(new Error(`Genie’s updater did not start within ${Math.round(patience / 1000)} s (see logs/genie-updater.log)`));
            }, patience);
            timer.unref?.();
            this.#waiting.push(waiter);
            // One start per wait: what else asks meanwhile waits for the same helper.
            if (this.#waiting.length === 1) {
                this.#log(`updater: starting ${this.#launch.file} ${this.#launch.args.join(' ')}`);
                try {
                    this.#options.startHelper(this.#launch);
                } catch (error) {
                    this.#log(`updater: could not be started: ${error instanceof Error ? error.message : String(error)}`);
                }
            }
        });
    }

    async #request(op: UpdaterOp, onProgress?: (percent: number) => void, wait?: InstallWait): Promise<unknown> {
        const helper = await this.#ensureHelper();
        const id = this.#nextId++;
        return new Promise((resolve, reject) => {
            this.#pending.set(id, { resolve, reject, ...(onProgress ? { progress: onProgress } : {}) });
            helper.send({ kind: 'request', id, op, ...(wait ? { wait } : {}) });
        });
    }

    /** The install's last steps: the helper is handed it, then this host exits (it maps the executable the installer replaces). */
    async #handOver(): Promise<void> {
        const wait: InstallWait = {
            pids: [this.#options.host.ownPid, ...this.#windowPids],
            installDir: this.#options.host.installDir,
            boundMs: this.#options.installWaitMs ?? INSTALL_WAIT_MS,
        };
        try {
            await this.#request('install', undefined, wait);
            this.#log('updater: it has the install; this host exits');
        } catch (error) {
            const why = error instanceof Error ? error.message : String(error);
            // Everything this host ran is already stopped: it exits either way. A person who clicked Install is never left
            // with no Genie — a helper that refused records and relaunches itself; one that is gone cannot, so this host does.
            this.#log(`updater: it did not take the install (${why}); this host exits regardless`);
            if (!(error instanceof HelperRefusal)) {
                try {
                    this.#options.handOverFailed?.(`Genie’s updater could not be handed the install: ${why}.`, this.#launch);
                } catch (failure) {
                    this.#log(`updater: Genie could not be started again: ${failure instanceof Error ? failure.message : String(failure)}`);
                }
            }
        }
        this.#options.exit();
    }
}

/**
 * The helper's environment, from the host's own — which came from the window that started it, so on Linux it carries the
 * AppImage's: `APPIMAGE` (the file electron-updater replaces), `APPDIR`, `ARGV0`, `OWD`. Not as Node: it is an Electron.
 */
export function updaterHelperEnv(env: NodeJS.ProcessEnv, genieHome: string): NodeJS.ProcessEnv {
    const out: NodeJS.ProcessEnv = { ...env, GENIE_HOME: genieHome };
    delete out['ELECTRON_RUN_AS_NODE'];
    return out;
}

/**
 * The host's drain at an install (`DrainAgentsPort`): who comes back is recorded ON DISK first — every agent with a session,
 * and separately who was mid-turn (shutdown-record.ts) — then every session ends. The next launch restores them once.
 */
export function hostDrainAgents(input: {
    agents: () => readonly { id: string; name: string }[];
    probe: (id: AgentId) => { running: boolean; turnState: string; inTurn?: boolean | undefined } | null;
    writeRunningAtQuit: (ids: readonly AgentId[]) => Promise<void>;
    writeInterruptedAtQuit: (ids: readonly AgentId[]) => Promise<void>;
    stopAll: (onLeft?: (left: number) => void) => Promise<void>;
    onRecordError?: (error: unknown) => void;
}): DrainAgentsPort {
    return {
        live: () => input.agents().filter((a) => input.probe(a.id as AgentId)?.running === true).map((a) => ({ id: a.id, name: a.name })),
        stopAll: recordThenStopAll({
            markRecorded: () => {},
            record: () => recordShutdown({
                agents: input.agents,
                probe: input.probe,
                markRunningAtQuit: input.writeRunningAtQuit,
                markInterruptedAtQuit: input.writeInterruptedAtQuit,
            }),
            stopAll: input.stopAll,
            ...(input.onRecordError ? { onRecordError: input.onRecordError } : {}),
        }),
    };
}
