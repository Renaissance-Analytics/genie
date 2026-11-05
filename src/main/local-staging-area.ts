import type { Dirent } from 'node:fs';
import { lstat, mkdir, readdir, rm, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { systemProcessTree, type ProcessInfo } from '../core/process-tree.js';
import { runtimeDir } from './paths.js';
import { restrictPrivateDirectories } from './private-credentials.js';
import { LocalUploads } from './local-uploads.js';

type ProcessReader = () => Promise<readonly ProcessInfo[] | null>;
const readProcesses: ProcessReader = async () => (await systemProcessTree.read?.()) ?? null;
const areas = new Map<string, Promise<LocalStagingArea>>();
let ownProcess: Promise<ProcessInfo> | null = null;

function self(table: readonly ProcessInfo[] | null): ProcessInfo {
    const row = table?.find(p => p.pid === process.pid);
    if (!row || !Number.isSafeInteger(row.started) || row.started <= 0) throw new Error('local staging cannot verify this process identity');
    return row;
}
function cachedSelf(): Promise<ProcessInfo> {
    if (!ownProcess) {
        const pending = readProcesses().then(self); ownProcess = pending;
        void pending.catch(() => { if (ownProcess === pending) ownProcess = null; });
    }
    return ownProcess;
}
function folderOwner(name: string): { pid: number; started: number } | null {
    const match = /^([1-9][0-9]*)-([1-9][0-9]*)$/.exec(name);
    if (!match) return null;
    const pid = Number(match[1]), started = Number(match[2]);
    return Number.isSafeInteger(pid) && Number.isSafeInteger(started) ? { pid, started } : null;
}
async function realDirectory(path: string): Promise<void> {
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('local staging needs its own real directory');
}

/** Process-owned staging under the runtime, shared by this host's connections, never by overlapping hosts. */
export class LocalStagingArea {
    readonly root: string;
    readonly directory: string;
    readonly #owner: ProcessInfo;
    readonly #read: ProcessReader;
    private constructor(root: string, owner: ProcessInfo, read: ProcessReader) {
        this.root = root; this.#owner = owner; this.#read = read;
        this.directory = join(root, `${owner.pid}-${owner.started}`);
    }

    static open(home: string, deps: { readProcesses?: ProcessReader } = {}): Promise<LocalStagingArea> {
        const root = resolve(runtimeDir(home), 'local-staging'), key = process.platform === 'win32' ? root.toLowerCase() : root;
        let opening = areas.get(key);
        if (!opening) {
            opening = (async () => {
                await mkdir(root, { recursive: true, mode: 0o700 }); await realDirectory(root);
                // Capture candidates BEFORE a fresh reading; a folder created by a new process during that reading is never deleted.
                const entries = await readdir(root, { withFileTypes: true });
                const hasCandidates = entries.some(e => folderOwner(e.name) && (e.isDirectory() || e.isSymbolicLink()));
                const read = deps.readProcesses ?? readProcesses;
                const table = deps.readProcesses || hasCandidates ? await read() : null;
                const owner = deps.readProcesses || hasCandidates ? self(table) : await cachedSelf();
                const area = new LocalStagingArea(root, owner, read);
                if (table !== null) await area.#removeDead(entries, table);
                await mkdir(area.directory, { recursive: true, mode: 0o700 }); await realDirectory(area.directory);
                // Both directories have a verified private ACL; this process's protected folder is independent of another host's.
                await restrictPrivateDirectories([root, area.directory]);
                return area;
            })();
            areas.set(key, opening);
            const pending = opening;
            void pending.catch(() => { if (areas.get(key) === pending) areas.delete(key); });
        }
        return opening;
    }

    createConnection(now?: () => number): LocalUploads {
        return new LocalUploads({ root: this.directory, ...(now ? { now } : {}) });
    }

    async sweep(): Promise<void> {
        await realDirectory(this.root);
        const entries = await readdir(this.root, { withFileTypes: true }), table = await this.#read();
        if (self(table).started !== this.#owner.started) throw new Error('local staging cannot verify its process ownership');
        await this.#removeDead(entries, table!);
    }

    async #removeDead(entries: readonly Dirent[], table: readonly ProcessInfo[]): Promise<void> {
        for (const entry of entries) {
            const owner = folderOwner(entry.name);
            if (!owner || (!entry.isDirectory() && !entry.isSymbolicLink())) continue;
            const matching = table.filter(p => p.pid === owner.pid);
            // Missing/invalid birth times are unknown, not proof that the recorded process has gone.
            if (matching.some(p => !Number.isSafeInteger(p.started) || p.started <= 0 || p.started === owner.started)) continue;
            await realDirectory(this.root);
            const path = join(this.root, entry.name);
            const info = await lstat(path).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; });
            if (info?.isSymbolicLink()) await unlink(path);
            else if (info?.isDirectory()) await rm(path, { recursive: true, force: true });
        }
    }
}
