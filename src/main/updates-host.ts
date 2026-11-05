import type { UpdateChannel } from '../core/update-channel.js';
import type { DrainAgentsPort, UpdateHost, UpdateHostOptions, UpdateState } from './updater.js';
import type { AgentId } from '../core/identity.js';

/**
 * THE UPDATER IN GENIE-HOST (the host split, P5b). Not built yet: this file names the shapes the P5b tests drive.
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

/** How to start Genie's own executable in its updater mode. */
export interface HelperLaunch {
    readonly file: string;
    readonly args: readonly string[];
}

/** The hello label the helper says: its link is the helper's, never a window's. */
export const UPDATER_HELPER_LABEL = 'genie updater';

export interface UpdatesCaller {
    /** A local window asked. */
    readonly window: boolean;
}

export interface UpdatesServiceOptions {
    readonly host: Omit<UpdateHostOptions, 'port' | 'defer' | 'spare'>;
    readonly startHelper: (launch: HelperLaunch) => void;
    readonly defaultLaunch: HelperLaunch;
    readonly windowConnected: () => boolean;
    readonly exit: () => void;
    readonly helperPatienceMs?: number;
    readonly installWaitMs?: number;
    readonly defer?: (fn: () => void, ms: number) => void;
    readonly log?: (line: string) => void;
}

const NOT_BUILT = 'P5b: the updater in the host is not built yet';

export class UpdatesService {
    constructor(_options: UpdatesServiceOptions) {}

    get updates(): UpdateHost {
        throw new Error(NOT_BUILT);
    }

    dump(): UpdateState {
        throw new Error(NOT_BUILT);
    }

    onEvent(_listener: (state: UpdateState) => void): () => void {
        return () => {};
    }

    call(_method: string, _args: readonly unknown[], _caller: UpdatesCaller): Promise<unknown> {
        return Promise.reject(new Error(NOT_BUILT));
    }

    setChannel(_channel: UpdateChannel): void {
        throw new Error(NOT_BUILT);
    }

    startAutoCheck(_schedule: (fn: () => void, ms: number) => () => void, _timing?: { initialMs: number; intervalMs: number }): () => void {
        throw new Error(NOT_BUILT);
    }

    helperLinked(_connection: string, _pid: number, _send: (event: UpdaterEvent) => void): { config: UpdaterConfig } {
        throw new Error(NOT_BUILT);
    }

    helperCall(_method: string, _args: readonly unknown[], _connection: string): unknown {
        throw new Error(NOT_BUILT);
    }

    helperDropped(_connection: string): void {}
}

/** The helper's environment, from the host's own (which came from the window that started it). */
export function updaterHelperEnv(_env: NodeJS.ProcessEnv, _genieHome: string): NodeJS.ProcessEnv {
    throw new Error(NOT_BUILT);
}

/** The host's drain at an install: who comes back recorded on disk, then every session ended. */
export function hostDrainAgents(_input: {
    agents: () => readonly { id: string; name: string }[];
    probe: (id: AgentId) => { running: boolean; turnState: string; inTurn?: boolean | undefined } | null;
    writeRunningAtQuit: (ids: readonly AgentId[]) => Promise<void>;
    writeInterruptedAtQuit: (ids: readonly AgentId[]) => Promise<void>;
    stopAll: (onLeft?: (left: number) => void) => Promise<void>;
    onRecordError?: (error: unknown) => void;
}): DrainAgentsPort {
    throw new Error(NOT_BUILT);
}
