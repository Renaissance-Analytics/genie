import type { ClientTransport } from '../core/remote-protocol.js';
import type { RunningProcess } from './upgrade.js';
import type { UpdaterPort } from './updater.js';
import type { InstallWait, UpdaterEvent } from './updates-host.js';

/**
 * THE UPDATER HELPER'S RULES (the host split, P5b). Not built yet: the shapes the P5b tests drive.
 */

export interface UpdaterLinkClient {
    call(method: string, args: readonly unknown[]): Promise<unknown>;
    onEvent(listener: (event: UpdaterEvent) => void): () => void;
    onClose(listener: () => void): void;
    close(): void;
}

export function connectUpdaterLink(_transport: ClientTransport, _token: string): Promise<UpdaterLinkClient | null> {
    return Promise.resolve(null);
}

export interface UpdaterHelperPorts {
    link(): Promise<UpdaterLinkClient | null>;
    port: UpdaterPort;
    pid: number;
    processes(): Promise<readonly RunningProcess[]>;
    alive(pid: number): boolean;
    sleep(ms: number): Promise<void>;
    now(): number;
    quit(): void;
    log(line: string): void;
    idleMs?: number;
    caseInsensitive?: boolean;
    schedule?: (fn: () => void, ms: number) => () => void;
}

export function runUpdaterHelper(_ports: UpdaterHelperPorts): { readonly done: Promise<void> } {
    return { done: Promise.resolve() };
}

export function waitForGenieGone(_input: {
    wait: InstallWait;
    ownPid: number;
    processes: () => Promise<readonly RunningProcess[]>;
    alive: (pid: number) => boolean;
    sleep: (ms: number) => Promise<void>;
    now: () => number;
    caseInsensitive?: boolean;
}): Promise<{ gone: true } | { gone: false; words: string }> {
    return Promise.reject(new Error('P5b: the updater helper is not built yet'));
}
