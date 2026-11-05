import { Worker } from 'node:worker_threads';
import { restrictPrivateDirectories, restrictPrivateFile } from './private-credentials.js';

export const MAX_STAGING_ACL_REQUESTS = 256;
const DEADLINE_MS = 60_000;
const REFUSED = 'Private Tynn credential permissions could not be secured.';
type WorkerPort = Pick<Worker, 'on' | 'once' | 'postMessage' | 'ref' | 'unref' | 'terminate'>;
type Pending = { timer: ReturnType<typeof setTimeout>; resolve(): void; reject(error: Error): void };

/** Staging alone uses this worker; credentials retain their existing helper/launch policy. */
export class StagingPermissionsClient {
    readonly #start: () => WorkerPort;
    readonly #deadlineMs: number;
    readonly #pending = new Map<number, Pending>();
    #worker: WorkerPort | null = null;
    #next = 0;
    #closed = false;
    #workerStarts = 0;
    #helperStarts = 0;
    #helperBase = 0;
    #helperPid: number | null = null;
    #threadId: number | null = null;

    constructor(options: { start?: () => WorkerPort; deadlineMs?: number } = {}) {
        // Both source tests and the packaged bundle are two levels below the application root.
        this.#start = options.start ?? (() => new Worker(new URL('../../dist/main/staging-acl-worker.js', import.meta.url)));
        this.#deadlineMs = options.deadlineMs ?? DEADLINE_MS;
    }
    get closed(): boolean { return this.#closed; }
    file(path: string): Promise<void> { return this.#call('file', [path]); }
    directories(paths: readonly string[]): Promise<void> { return this.#call('directories', [...paths]); }
    diagnostics() { return { workerStarts: this.#workerStarts, helperStarts: this.#helperStarts, helperPid: this.#helperPid, threadId: this.#threadId, pending: this.#pending.size }; }

    #call(mode: 'file' | 'directories', paths: string[]): Promise<void> {
        if (this.#closed || this.#pending.size >= MAX_STAGING_ACL_REQUESTS || this.#next >= Number.MAX_SAFE_INTEGER || paths.length < 1 || paths.length > 4 || paths.some(path => typeof path !== 'string' || !path || path.length > 32768)) return Promise.reject(new Error(REFUSED));
        let worker = this.#worker;
        if (!worker) {
            try { worker = this.#start(); } catch { return Promise.reject(new Error(REFUSED)); }
            this.#worker = worker; this.#workerStarts++; this.#helperBase = this.#helperStarts;
            const own = worker;
            own.on('message', (message: unknown) => this.#reply(own, message));
            own.on('error', () => this.#lose(own)); own.on('exit', () => this.#lose(own)); own.unref();
        }
        const own = worker, id = ++this.#next;
        return new Promise<void>((resolve, reject) => {
            this.#pending.set(id, { resolve, reject, timer: setTimeout(() => this.#lose(own), this.#deadlineMs) });
            own.ref();
            try { own.postMessage({ kind: 'staging-acl-request', id, mode, paths }); } catch { this.#lose(own); }
        });
    }
    #reply(worker: WorkerPort, message: unknown): void {
        if (worker !== this.#worker || !message || typeof message !== 'object') return;
        const value = message as { kind?: unknown; id?: unknown; ok?: unknown; helper?: { starts?: unknown; pid?: unknown; threadId?: unknown } };
        if (value.kind !== 'staging-acl-result' || typeof value.id !== 'number') return;
        const pending = this.#pending.get(value.id); if (!pending) return;
        const h = value.helper;
        if (typeof value.ok !== 'boolean' || !h || typeof h.starts !== 'number' || !Number.isSafeInteger(h.starts) || h.starts < 0 || (h.pid !== null && (typeof h.pid !== 'number' || !Number.isSafeInteger(h.pid) || h.pid <= 0)) || typeof h.threadId !== 'number' || !Number.isSafeInteger(h.threadId) || h.threadId <= 0) { this.#lose(worker); return; }
        this.#helperStarts = Math.max(this.#helperStarts, this.#helperBase + h.starts); this.#helperPid = h.pid as number | null; this.#threadId = h.threadId;
        this.#pending.delete(value.id); clearTimeout(pending.timer);
        if (value.ok) pending.resolve(); else pending.reject(new Error(REFUSED));
        if (!this.#pending.size) worker.unref();
    }
    #rejectPending(): void {
        for (const pending of this.#pending.values()) { clearTimeout(pending.timer); pending.reject(new Error(REFUSED)); }
        this.#pending.clear();
    }
    #lose(worker: WorkerPort): void {
        if (worker !== this.#worker) return;
        this.#worker = null; this.#helperPid = null; this.#threadId = null; this.#rejectPending();
        worker.unref(); void worker.terminate().catch(() => {});
    }
    async stop(): Promise<void> {
        this.#closed = true; const worker = this.#worker; this.#worker = null;
        this.#helperPid = null; this.#threadId = null; this.#rejectPending();
        if (!worker) return;
        // Closing the worker's owned stdin ends its helper, including if the worker must be terminated.
        let timer: ReturnType<typeof setTimeout> | undefined;
        const ended = new Promise<void>(resolve => { worker.once('exit', () => resolve()); timer = setTimeout(resolve, Math.min(2000, this.#deadlineMs)); });
        worker.ref(); try { worker.postMessage({ kind: 'staging-acl-stop' }); } catch { /* End only this owned worker below. */ }
        await ended; clearTimeout(timer); await worker.terminate().catch(() => {}); worker.unref();
    }
}

let shared: StagingPermissionsClient | null = null;
export function stagingPermissionsClient(): StagingPermissionsClient {
    if (!shared || shared.closed) shared = new StagingPermissionsClient(); return shared;
}
export function secureStagingDirectories(paths: readonly string[]): Promise<void> {
    return process.platform === 'win32' ? stagingPermissionsClient().directories(paths) : restrictPrivateDirectories(paths);
}
export function secureStagingFile(path: string): Promise<void> {
    return process.platform === 'win32' ? stagingPermissionsClient().file(path) : restrictPrivateFile(path);
}
