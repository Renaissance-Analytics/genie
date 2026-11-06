import { watch } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { listRepos } from '../core/repo-registry.js';

/**
 * WHAT MOVES A WORKSPACE'S VERDICT WHEN NOBODY ASKS: a pull that changes a file the verdict reads, while an agent runs.
 *
 * Small on purpose, because a workstation may hold many workspaces. It watches only the few folders those files are in,
 * each alone and not its tree, and reads each file's size and time, nothing more. The verdict is read again only when one
 * of them really changed, so a busy folder costs a few readings. It runs no git: reading the verdict is `refresh`'s, which
 * keeps its own rules. A slow pass covers what a watcher misses, or a folder that is not watched: on Windows, every one.
 *
 * A config file's own includes are not followed here: a change to an included file is seen at the next launch's read.
 */

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export interface TrustWatchPorts {
    workspaces(): readonly { id: string; path: string }[];
    readText(path: string): Promise<string | null>;
    /** A cheap reading of one file (its size and time), or `null` when it is not there. */
    fingerprint(path: string): Promise<string | null>;
    /** Watch one folder, not its subfolders. The stop, or `null` when it cannot be watched. */
    watchFolder(folder: string, changed: () => void): (() => void) | null;
    refresh(workspaceId: string): void;
    settleMs: number;
}

interface Watched {
    reading: string | null;
    readonly stops: Map<string, () => void>;
    timer: ReturnType<typeof setTimeout> | null;
    running: boolean;
    again: boolean;
}

/**
 * ON WINDOWS NOTHING INSIDE A WORKSPACE IS WATCHED: a folder watcher there stops a person renaming that folder or anything
 * above it (measured on a Windows runner: EPERM, for the workspace and its parent; deleting it was not stopped). So Windows
 * has the slow pass alone, and a shorter one, since a reading of a few files holds nothing.
 */
export const TRUST_PASS_MS = process.platform === 'win32' ? 15_000 : 60_000;

/** One folder, not its subfolders, keeping nothing alive. The stop, or `null` when it is not watched: the slow pass covers it. */
export function watchOneFolder(folder: string, changed: () => void, platform: NodeJS.Platform = process.platform): (() => void) | null {
    if (platform === 'win32') return null;
    try {
        const watcher = watch(folder, { persistent: false }, () => changed());
        watcher.on('error', () => { watcher.close(); });
        return () => watcher.close();
    } catch {
        return null;
    }
}

const OF_EACH_FOLDER = [['.claude', 'settings.json'], ['.claude', 'settings.local.json'], ['.mcp.json'], ['.codex', 'config.toml'], ['package.json']];

export class TrustWatch {
    readonly #ports: TrustWatchPorts;
    readonly #watched = new Map<string, Watched>();
    #stopped = false;

    constructor(ports: TrustWatchPorts) {
        this.#ports = ports;
    }

    /** Every workspace once. The first takes the readings; after that, a change reads the verdict again. */
    async pass(): Promise<void> {
        if (this.#stopped) return;
        const now = this.#ports.workspaces();
        const ids = new Set(now.map((w) => w.id));
        for (const id of [...this.#watched.keys()]) if (!ids.has(id)) this.#forget(id);
        for (const workspace of now) await this.#check(workspace.id, workspace.path);
    }

    stop(): void {
        this.#stopped = true;
        for (const id of [...this.#watched.keys()]) this.#forget(id);
    }

    get watching(): readonly string[] {
        return [...this.#watched.values()].flatMap((w) => [...w.stops.keys()]);
    }

    #forget(id: string): void {
        const watched = this.#watched.get(id);
        if (!watched) return;
        if (watched.timer) clearTimeout(watched.timer);
        for (const stop of watched.stops.values()) stop();
        this.#watched.delete(id);
    }

    async #text(path: string): Promise<string | null> {
        try { return await this.#ports.readText(path); } catch { return null; }
    }

    /** The git config files of one folder: its `.git` folder's, or, for a submodule or a worktree, where its `.git` file points. */
    async #gitFiles(folder: string): Promise<string[]> {
        const pointer = /^gitdir:\s*(.+?)\s*$/m.exec((await this.#text(join(folder, '.git'))) ?? '')?.[1];
        const gitDir = pointer ? resolve(folder, pointer) : join(folder, '.git');
        return [join(gitDir, 'config'), join(gitDir, 'config.worktree')];
    }

    async #filesOf(root: string): Promise<string[]> {
        let manifest: unknown = null;
        try { manifest = JSON.parse((await this.#text(join(root, 'project.json'))) ?? 'null'); } catch { /* the slow pass reads it again */ }
        const folders = [root, ...(isRecord(manifest) ? listRepos(manifest) : []).filter((r) => r.path !== '.').map((r) => join(root, ...r.path.split('/')))];
        const files = [join(root, 'project.json')];
        for (const folder of folders) {
            files.push(...OF_EACH_FOLDER.map((parts) => join(folder, ...parts)), ...(await this.#gitFiles(folder)));
        }
        return files;
    }

    #entry(id: string): Watched {
        let watched = this.#watched.get(id);
        if (!watched) {
            watched = { reading: null, stops: new Map(), timer: null, running: false, again: false };
            this.#watched.set(id, watched);
        }
        return watched;
    }

    async #check(id: string, root: string): Promise<void> {
        if (this.#stopped) return;
        const watched = this.#entry(id);
        if (watched.running) { watched.again = true; return; }
        watched.running = true;
        try {
            do {
                watched.again = false;
                const files = await this.#filesOf(root);
                const readings = await Promise.all(files.map(async (file) => {
                    try { return await this.#ports.fingerprint(file); } catch { return null; }
                }));
                if (this.#stopped || this.#watched.get(id) !== watched) return;
                const reading = files.map((file, i) => `${file}=${readings[i] ?? '-'}`).join('\n');
                const changed = watched.reading !== null && watched.reading !== reading;
                watched.reading = reading;
                this.#arm(id, root, watched, new Set([root, ...files.filter((_, i) => readings[i] !== null).map((file) => dirname(file))]));
                if (changed) this.#ports.refresh(id);
            } while (watched.again);
        } finally {
            watched.running = false;
        }
    }

    #arm(id: string, root: string, watched: Watched, folders: ReadonlySet<string>): void {
        for (const [folder, stop] of watched.stops) {
            if (!folders.has(folder)) { stop(); watched.stops.delete(folder); }
        }
        for (const folder of folders) {
            if (watched.stops.has(folder)) continue;
            const stop = this.#ports.watchFolder(folder, () => this.#settle(id, root, watched));
            if (stop) watched.stops.set(folder, stop);
        }
    }

    #settle(id: string, root: string, watched: Watched): void {
        if (this.#stopped || this.#watched.get(id) !== watched) return;
        if (watched.timer) clearTimeout(watched.timer);
        watched.timer = setTimeout(() => {
            watched.timer = null;
            void this.#check(id, root).catch(() => { /* the slow pass reads it again */ });
        }, this.#ports.settleMs);
        watched.timer.unref?.();
    }
}
