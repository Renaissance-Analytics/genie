import { readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';
import { formatLike, readEnvelopeSites, siteEntryFor, siteKeyFor, withSiteEntry } from '../core/envelope-sites.js';
import type { CreateSiteInput, SiteInfo, SiteManager } from './site-manager.js';

/**
 * A WORKSPACE'S SITES COME FROM ITS ENVELOPE (§6.6) — the main-process half over `core/envelope-sites.ts`.
 *
 * The regression this closes: Genie 2's site manager kept sites in memory only, so Hosting started empty on
 * every launch and a site added in Genie 2 vanished on restart — while every `.agi` envelope's project.json
 * still declared the sites Genie 1 hosted.
 *
 * - **Listed.** Every registered workspace's declared sites are known to the site manager — servable ones as
 *   sites, the rest as `unservable` rows carrying the reason.
 * - **Started by Genie 1's boot rule** (`resumeEnabledSites`, genie#190/#407/#672): an `enabled` site in an
 *   AWAKE workspace is started, unless the person stopped it. A disabled site, or any site of a hibernating
 *   workspace, is listed and not started; a waking workspace brings its enabled sites up.
 * - **The person's Stop is machine-local** (genie#407): `enabled` lives in the git-tracked envelope — the
 *   project's fact — while "I stopped it" is one person's decision on one machine, kept under Genie's own
 *   data. A Start lifts it. Hibernation is not a person's stop and leaves no mark.
 * - **Created and removed sites are written back** to the envelope's `sites` key — atomically, every other
 *   key carried through, in the file's own indentation and line endings. A workspace with no project.json
 *   is told to convert first, the same refusal the repo operations give.
 */

export interface EnvelopeSitesPorts {
    readonly fs: {
        /** The file's text, or `null` when it does not exist. */
        readText(path: string): Promise<string | null>;
        /** Replace the file whole (temp + rename): it is the old file or the new one, never half of either. */
        writeTextAtomic(path: string, text: string): Promise<void>;
        exists(path: string): Promise<boolean>;
    };
    /** The person's machine-local stops, as `<workspaceId>/<key>` ids. */
    readonly runState: { load(): Promise<readonly string[]>; save(stopped: readonly string[]): Promise<void> };
    /** The workspace's service env (its engines + the shared ones), for every process of its sites. */
    readonly envFor: (workspaceId: string) => Readonly<Record<string, string>>;
    readonly log?: (line: string) => void;
}

let tmpCounter = 0;

/**
 * The real filesystem for {@link EnvelopeSitesPorts.fs}. The write is a temp file beside the target, then
 * a rename over it — atomic on NTFS and POSIX — with the rename retried briefly when Windows refuses it
 * because an indexer or an editor holds the file for a moment (the rule `store.ts` learned in the VM).
 */
export function nodeEnvelopeFs(): EnvelopeSitesPorts['fs'] {
    return {
        readText: async (path) => {
            try {
                return await readFile(path, 'utf8');
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
                throw error;
            }
        },
        writeTextAtomic: async (path, text) => {
            const tmp = `${path}.${process.pid}.${++tmpCounter}.tmp`;
            await writeFile(tmp, text, 'utf8');
            for (let attempt = 0; ; attempt += 1) {
                try {
                    await rename(tmp, path);
                    return;
                } catch (error) {
                    const code = (error as NodeJS.ErrnoException).code;
                    if (attempt < 5 && (code === 'EPERM' || code === 'EBUSY' || code === 'EACCES')) {
                        await new Promise((r) => setTimeout(r, 20 * (attempt + 1)));
                        continue;
                    }
                    await rm(tmp, { force: true }).catch(() => undefined);
                    throw error;
                }
            }
        },
        exists: async (path) => { try { await stat(path); return true; } catch { return false; } },
    };
}

export interface WorkspaceRef {
    readonly id: string;
    readonly path: string;
    readonly asleep?: boolean;
}

interface Tracked {
    readonly workspaceId: string;
    readonly key: string;
    readonly enabled: boolean;
    readonly servable: boolean;
}

export class EnvelopeSites {
    readonly #sites: SiteManager;
    readonly #ports: EnvelopeSitesPorts;
    /** site id → where it is declared. */
    readonly #tracked = new Map<string, Tracked>();
    /** workspace id → what was seen of it at the last sync. */
    readonly #workspaces = new Map<string, { path: string; asleep: boolean }>();
    #stopped: Set<string> | null = null;
    #queue: Promise<void> = Promise.resolve();

    constructor(sites: SiteManager, ports: EnvelopeSitesPorts) {
        this.#sites = sites;
        this.#ports = ports;
    }

    /**
     * Bring the site manager in line with the registered workspaces: load the sites of a workspace seen for
     * the first time (starting its enabled ones when it is awake), start the enabled sites of a workspace that
     * woke, and forget the sites of a workspace no longer registered (its envelope untouched). Serialised:
     * a second call waits for the first.
     */
    sync(workspaces: readonly WorkspaceRef[]): Promise<void> {
        const run = this.#queue.then(() => this.#sync(workspaces));
        this.#queue = run.catch(() => undefined);
        return run;
    }

    async #sync(workspaces: readonly WorkspaceRef[]): Promise<void> {
        const stopped = await this.#stops();
        const seen = new Set<string>();
        for (const w of workspaces) {
            seen.add(w.id);
            const asleep = w.asleep === true;
            const before = this.#workspaces.get(w.id);
            if (!before) {
                this.#workspaces.set(w.id, { path: w.path, asleep });
                await this.#load(w, asleep, stopped);
            } else if (before.asleep && !asleep) {
                this.#workspaces.set(w.id, { path: w.path, asleep });
                this.#resume(w.id, stopped);
            } else if (before.asleep !== asleep) {
                this.#workspaces.set(w.id, { path: w.path, asleep });
            }
        }
        for (const id of [...this.#workspaces.keys()]) {
            if (seen.has(id)) continue;
            this.#workspaces.delete(id);
            for (const [siteId, t] of [...this.#tracked]) {
                if (t.workspaceId !== id) continue;
                this.#sites.remove(siteId);
                this.#tracked.delete(siteId);
            }
        }
    }

    async #load(w: WorkspaceRef, asleep: boolean, stopped: Set<string>): Promise<void> {
        const path = join(w.path, 'project.json');
        let manifest: unknown;
        try {
            const text = await this.#ports.fs.readText(path);
            if (text === null) return;
            manifest = JSON.parse(text);
        } catch (error) {
            this.#ports.log?.(`[sites] ${path} could not be read; its sites are not listed: ${error instanceof Error ? error.message : String(error)}`);
            return;
        }
        for (const site of readEnvelopeSites(manifest)) {
            const repoPath = site.repoDir === null ? w.path : site.repoDir === '.' ? w.path : join(w.path, ...site.repoDir.split('/'));
            const unservable = (host: string, reason: string) => {
                const info = this.#sites.declareUnservable({ workspaceId: w.id, name: site.name, host, repoPath, reason, key: site.key });
                this.#tracked.set(info.id, { workspaceId: w.id, key: site.key, enabled: site.enabled, servable: false });
            };
            if (!site.ok) { unservable(site.host, site.reason); continue; }
            const host = `${site.name}.gen`;
            if (site.repoDir !== '.' && !(await this.#ports.fs.exists(repoPath))) { unservable(host, `its folder ${site.repoDir} does not exist in the workspace`); continue; }
            const env = { ...this.#ports.envFor(w.id), ...(site.portEnv ?? {}) };
            const input: CreateSiteInput = {
                name: site.name,
                workspaceId: w.id,
                repoPath,
                serve: site.serve,
                ...(site.devServer ? { devServer: site.devServer } : {}),
                ...(site.hostPort !== undefined ? { hostPort: site.hostPort } : {}),
                ...(Object.keys(env).length > 0 ? { env } : {}),
            };
            let info: SiteInfo;
            try {
                info = this.#sites.declare(input);
            } catch (error) {
                // Two declarations of one name (in two workspaces): the second is listed, with why.
                unservable(host, error instanceof Error ? error.message : String(error));
                continue;
            }
            this.#tracked.set(info.id, { workspaceId: w.id, key: site.key, enabled: site.enabled, servable: true });
            if (site.enabled && !asleep && !stopped.has(`${w.id}/${site.key}`)) this.#tryStart(info.id);
        }
    }

    #resume(workspaceId: string, stopped: Set<string>): void {
        for (const [siteId, t] of this.#tracked) {
            if (t.workspaceId === workspaceId && t.servable && t.enabled && !stopped.has(`${workspaceId}/${t.key}`)) this.#tryStart(siteId);
        }
    }

    /** A boot/wake start that is refused (no Caddy, a root outside the repo) is kept on the site as its problem; the others still start. */
    #tryStart(siteId: string): void {
        try {
            this.#sites.start(siteId);
        } catch (error) {
            this.#ports.log?.(`[sites] ${siteId} was not started: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    async #stops(): Promise<Set<string>> {
        if (this.#stopped === null) {
            try {
                this.#stopped = new Set(await this.#ports.runState.load());
            } catch (error) {
                this.#ports.log?.(`[sites] the stopped-sites record could not be read; nothing counts as stopped: ${error instanceof Error ? error.message : String(error)}`);
                this.#stopped = new Set();
            }
        }
        return this.#stopped;
    }

    async #remember(siteId: string, stopped: boolean): Promise<void> {
        const t = this.#tracked.get(siteId);
        if (!t) return;
        const set = await this.#stops();
        const id = `${t.workspaceId}/${t.key}`;
        if (stopped === set.has(id)) return;
        if (stopped) set.add(id);
        else set.delete(id);
        await this.#ports.runState.save([...set].sort());
    }

    /** The person's Stop: the processes end and the stop is remembered on this machine through the next launch. */
    async stop(siteId: string): Promise<boolean> {
        if (!this.#sites.stop(siteId)) return false;
        await this.#remember(siteId, true);
        return true;
    }

    /** The person's Start: lifts a remembered stop, and starts it (throws the reason when it cannot be served). */
    async start(siteId: string): Promise<SiteInfo> {
        const info = this.#sites.start(siteId);
        await this.#remember(siteId, false);
        return info;
    }

    async #manifest(workspaceId: string): Promise<{ path: string; text: string; manifest: Record<string, unknown>; workspacePath: string }> {
        const w = this.#workspaces.get(workspaceId);
        if (!w) throw new Error(`no workspace ${workspaceId}`);
        const path = join(w.path, 'project.json');
        const text = await this.#ports.fs.readText(path);
        if (text === null) throw new Error('this workspace has no project.json; a site is kept in the workspace’s envelope — convert it to an envelope first');
        let manifest: unknown;
        try { manifest = JSON.parse(text); } catch (error) { throw new Error(`${path} is not valid JSON and was not touched (${error instanceof Error ? error.message : String(error)})`); }
        if (typeof manifest !== 'object' || manifest === null || Array.isArray(manifest)) throw new Error(`${path} is not a JSON object and was not touched`);
        return { path, text, manifest: manifest as Record<string, unknown>, workspacePath: w.path };
    }

    /**
     * Create a site from Hosting, and keep it: the entry is written to the workspace's project.json `sites`.
     * Refused with nothing started or written when the workspace has no envelope or the folder is not one of
     * its repos; when the write itself fails, the site is removed again and the failure is thrown.
     */
    async create(input: CreateSiteInput): Promise<SiteInfo> {
        const m = await this.#manifest(input.workspaceId);
        const rel = relative(m.workspacePath, input.repoPath).replace(/\\/g, '/');
        if (rel.startsWith('..') || isAbsolute(rel)) throw new Error(`a site serves a folder inside its workspace; ${input.repoPath} is outside it`);
        const entry = siteEntryFor(m.manifest, {
            name: input.name.toLowerCase(),
            repoDir: rel === '' ? '.' : rel,
            serve: input.serve,
            ...(input.devServer ? { devServer: input.devServer } : {}),
            ...(input.hostPort !== undefined ? { hostPort: input.hostPort } : {}),
        });
        if (!entry.ok) throw new Error(entry.reason);
        let key = siteKeyFor(input.workspaceId, input.name);
        const existing = typeof m.manifest.sites === 'object' && m.manifest.sites !== null ? (m.manifest.sites as Record<string, unknown>) : {};
        for (let n = 2; key in existing; n++) key = siteKeyFor(input.workspaceId, `${input.name}#${n}`);

        const info = this.#sites.create(input);
        try {
            await this.#ports.fs.writeTextAtomic(m.path, formatLike(m.text, withSiteEntry(m.manifest, key, entry.entry)));
        } catch (error) {
            this.#sites.remove(info.id);
            throw new Error(`${input.name}.gen was not kept: ${m.path} could not be written (${error instanceof Error ? error.message : String(error)})`);
        }
        this.#tracked.set(info.id, { workspaceId: input.workspaceId, key, enabled: true, servable: true });
        return info;
    }

    /**
     * Remove a site: stopped, forgotten, and — for a site a workspace declares — deleted from its project.json.
     * The envelope is written FIRST: a write that fails leaves the site exactly as it was, still listed.
     */
    async remove(siteId: string): Promise<boolean> {
        const t = this.#tracked.get(siteId);
        if (t) {
            const m = await this.#manifest(t.workspaceId);
            const sites = typeof m.manifest.sites === 'object' && m.manifest.sites !== null ? (m.manifest.sites as Record<string, unknown>) : {};
            if (t.key in sites) await this.#ports.fs.writeTextAtomic(m.path, formatLike(m.text, withSiteEntry(m.manifest, t.key, null)));
            await this.#remember(siteId, false);
            this.#tracked.delete(siteId);
        }
        return this.#sites.remove(siteId);
    }
}
