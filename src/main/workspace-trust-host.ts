import { join, relative, isAbsolute } from 'node:path';
import { firstStartWords, readEnvelopeSites, siteRunFingerprint, type ServableSite } from '../core/envelope-sites.js';
import { listRepos } from '../core/repo-registry.js';
import { flowTrustItems } from '../core/workspace-flows.js';
import { processTrustItems } from '../core/workspace-processes.js';
import { npmRunTarget, recordSaysYes, trustHash, trustVerdict, unsafeGitKeys, type GitConfigEntry, type TrustFlow, type TrustHook, type TrustList, type TrustProcess, type TrustServer } from '../core/workspace-trust.js';
import { isExactlyGenieStopHook } from './config-sync-targets.js';

/**
 * WHAT A WORKSPACE'S OWN FILES SAY WOULD RUN, AND THE ONE VERDICT EVERYTHING READS. Git reads, agents and sites ask here. The record is on this machine, never in a repo.
 *
 * What Genie itself wrote is left off the list, or it would ask every time. That is matched by its exact form, not by a name or a word in it: a folder can name a server `genie`, or write a hook that mentions imDone.
 */
export interface TrustListPorts {
    readText(path: string): Promise<string | null>;
    gitConfig(cwd: string): Promise<GitConfigEntry[]>;
    /** Whether git tracks this file. Throws, or is absent, when it can't say, which counts as yes. */
    isTracked?(root: string, relativePath: string): Promise<boolean>;
    /** The names of the files in a folder (Tynn #756, PR9b: `.flows/` and `.processes/`). Rejects when it is not there; absent = those folders are not read. */
    listDir?(dir: string): Promise<string[]>;
}

export interface TrustView { readonly trusted: boolean; readonly changed: boolean; readonly list: TrustList }

export interface WorkspaceTrustPorts extends TrustListPorts {
    workspaces(): readonly { readonly id: string; readonly path: string; readonly asleep?: boolean }[];
    record(): { readonly carried: readonly string[]; readonly workspaces: Readonly<Record<string, string>> };
    recordWorkspace(workspaceId: string, hash: string): Promise<void>;
    /** The person's Untrust: its record gone, and it no longer carried. */
    forgetWorkspace(workspaceId: string): Promise<void>;
    approveSites(workspaceId: string): Promise<void>;
    /** The verdict differs from the last one read, or this is the first. */
    verdictMoved?(workspaceId: string): void;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const OUR_SERVERS: ReadonlySet<string> = new Set(['genie', 'tynn', 'genie-agentinbox-channel']);
/** Settings that change how Claude Code looks and nothing else, checked against its published schema. An allow-list, as with git config: anything else goes on the list, a key nobody has heard of included. */
const SETTINGS_FOR_LOOKS_ONLY: ReadonlySet<string> = new Set(['$schema', 'theme', 'spinnerTipsEnabled', 'terminalProgressBarEnabled', 'showTurnDuration', 'prefersReducedMotion', 'viewMode', 'editorMode', 'syntaxHighlightingDisabled', 'verbose']);

function settingsRows(file: string, text: string, approvalsOf: { readonly approvals: string[] } | null): TrustHook[] {
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { return [{ file, event: 'unreadable', command: text.slice(0, 4000) }]; }
    if (!isRecord(parsed)) return [{ file, event: 'unreadable', command: text.slice(0, 4000) }];
    const rows: TrustHook[] = [];
    for (const [key, value] of Object.entries(parsed)) {
        if (SETTINGS_FOR_LOOKS_ONLY.has(key)) continue;
        if (key === 'permissions' && approvalsOf && isRecord(value)) {
            // THIS MACHINE'S OWN CHOICES, in a file no commit brought (Tynn #599; the owner, 2026-11-10: "Once I trust a
            // workspace I should not have to approve anything else"). Claude Code writes every "always allow" here; counting
            // any of it untrusted the workspace on each approval. Permissions run nothing: shown on the list, never hashed.
            // A committed file's permissions still count (approvalsOf is null for it), and so do this file's hooks and env.
            const allow = Array.isArray(value.allow) ? value.allow.filter((rule): rule is string => typeof rule === 'string') : [];
            approvalsOf.approvals.push(...allow);
            continue;
        }
        if (key !== 'hooks' || !isRecord(value)) { rows.push({ file, event: key, command: JSON.stringify(value) }); continue; }
        for (const [event, entries] of Object.entries(value)) {
            for (const entry of Array.isArray(entries) ? entries : [entries]) {
                const hooks = isRecord(entry) && Array.isArray(entry.hooks) ? entry.hooks : [entry];
                for (const hook of hooks) {
                    const command = isRecord(hook) && typeof hook.command === 'string' ? hook.command : JSON.stringify(hook);
                    if (event === 'Stop' && isExactlyGenieStopHook(command)) continue;
                    rows.push({ file, event, command });
                }
            }
        }
    }
    return rows;
}

const commandLine = (entry: Record<string, unknown>): string => {
    const args = Array.isArray(entry.args) ? entry.args.map(String) : [];
    return typeof entry.command === 'string' ? [entry.command, ...args].join(' ') : JSON.stringify(entry);
};

function mcpJsonRows(file: string, text: string): TrustServer[] {
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { return [{ file, name: 'unreadable', command: text.slice(0, 4000) }]; }
    const servers = isRecord(parsed) && isRecord(parsed.mcpServers) ? parsed.mcpServers : {};
    return Object.entries(servers).flatMap(([name, entry]) => {
        if (!isRecord(entry)) return [{ file, name, command: JSON.stringify(entry) }];
        // Ours are addresses, and start nothing. One of these names with a command is the folder's.
        if (OUR_SERVERS.has(name) && typeof entry.command !== 'string') return [];
        return [{ file, name, command: commandLine(entry) }];
    });
}

function codexRows(file: string, text: string): TrustServer[] {
    const rows: TrustServer[] = [];
    for (const section of text.split(/^(?=\[)/m)) {
        const name = /^\[mcp_servers\.([^\].]+)\]/.exec(section)?.[1];
        if (!name) continue;
        const command = /^\s*command\s*=\s*"([^"]*)"/m.exec(section)?.[1];
        if (command === undefined && OUR_SERVERS.has(name)) continue;
        const args = /^\s*args\s*=\s*\[([^\]]*)\]/m.exec(section)?.[1];
        const words = [...(args ?? '').matchAll(/"([^"]*)"/g)].map((m) => m[1]!);
        rows.push({ file, name, command: command === undefined ? section.trim().slice(0, 4000) : [command, ...words].join(' ') });
    }
    return rows;
}

async function npmScriptOf(root: string, site: ServableSite, read: TrustListPorts['readText']): Promise<string | null> {
    const script = site.devServer ? npmRunTarget(site.devServer.command) : null;
    if (script === null) return null;
    const folder = site.repoDir === '.' ? root : join(root, ...site.repoDir.split('/'));
    try {
        const parsed: unknown = JSON.parse((await read(join(folder, 'package.json'))) ?? 'null');
        const value = isRecord(parsed) && isRecord(parsed.scripts) ? parsed.scripts[script] : undefined;
        return typeof value === 'string' ? value : null;
    } catch { return null; }
}

export async function readTrustList(path: string, ports: TrustListPorts): Promise<TrustList> {
    const hooks: TrustHook[] = [];
    const approvals: string[] = [];
    const committed = await ports.readText(join(path, '.claude', 'settings.json'));
    if (committed !== null) hooks.push(...settingsRows('.claude/settings.json', committed, null));
    const local = await ports.readText(join(path, '.claude', 'settings.local.json'));
    if (local !== null) {
        const tracked = await (ports.isTracked?.(path, '.claude/settings.local.json') ?? Promise.resolve(true)).catch(() => true);
        hooks.push(...settingsRows('.claude/settings.local.json', local, tracked ? null : { approvals }));
    }
    const servers: TrustServer[] = [];
    const mcp = await ports.readText(join(path, '.mcp.json'));
    if (mcp !== null) servers.push(...mcpJsonRows('.mcp.json', mcp));
    const codex = await ports.readText(join(path, '.codex', 'config.toml'));
    if (codex !== null) servers.push(...codexRows('.codex/config.toml', codex));

    let manifest: unknown = null;
    try { manifest = JSON.parse((await ports.readText(join(path, 'project.json'))) ?? 'null'); } catch { /* no sites can be read from it */ }
    const sites = [];
    for (const site of readEnvelopeSites(manifest)) {
        if (!site.ok) continue;
        const words = firstStartWords(site);
        sites.push({ key: site.key, fingerprint: siteRunFingerprint(site), runs: words.runs, folder: words.folder, npmScript: await npmScriptOf(path, site, ports.readText) });
    }
    const folders = [path, ...(isRecord(manifest) ? listRepos(manifest) : []).filter((r) => r.path !== '.').map((r) => join(path, ...r.path.split('/')))];
    const seen = new Set<string>();
    const gitKeys: GitConfigEntry[] = [];
    for (const folder of folders) {
        for (const entry of unsafeGitKeys(await ports.gitConfig(folder))) {
            const id = `${entry.key}\n${entry.value}`;
            if (!seen.has(id)) { seen.add(id); gitKeys.push(entry); }
        }
    }
    // What a CLONE brings (Tynn #756, PR9b): the commands in `.flows/` and `.processes/`, shown before anything is created.
    const flows = await rowsIn(path, '.flows', ports, (file, value) => flowTrustItems([{ path: file, value }]));
    const processes = await rowsIn(path, '.processes', ports, (file, value) => processTrustItems([{ path: file, value }]));
    return { sites, hooks, servers, gitKeys, approvals, ...(flows.length > 0 ? { flows } : {}), ...(processes.length > 0 ? { processes } : {}) };
}

/**
 * EVERY FILE AND FOLDER THE LIST ABOVE LOOKS AT, asked of the list itself (Tynn #955): what the watch must look at too
 * (trust-watch.ts), so a file added to the list is watched without anyone remembering to add it there. Runs no git: the
 * folders whose git config counts are the watch's own to find (a `.git` file's target). Reads what the list reads.
 */
export async function trustListReads(path: string, ports: Pick<TrustListPorts, 'readText' | 'listDir'>): Promise<{ files: string[]; dirs: string[] }> {
    const files = new Set<string>();
    const dirs = new Set<string>();
    await readTrustList(path, {
        readText: (file) => { files.add(file); return ports.readText(file); },
        gitConfig: async () => [],
        listDir: (dir) => { dirs.add(dir); return ports.listDir ? ports.listDir(dir) : Promise.reject(new Error('this folder is not listed here')); },
    });
    return { files: [...files], dirs: [...dirs] };
}

/** The `.json` files of one folder of the workspace that would run something, in name order; a folder that is not there, or a file that is not JSON, has none. */
async function rowsIn(root: string, dir: string, ports: TrustListPorts, rowsOf: (file: string, value: unknown) => readonly (TrustFlow | TrustProcess)[]): Promise<(TrustFlow | TrustProcess)[]> {
    if (!ports.listDir) return [];
    let names: string[];
    try { names = await ports.listDir(join(root, dir)); } catch { return []; }
    const out: (TrustFlow | TrustProcess)[] = [];
    for (const name of names.filter((n) => n.toLowerCase().endsWith('.json')).sort()) {
        const text = await ports.readText(join(root, dir, name));
        if (text === null) continue;
        let value: unknown;
        try { value = JSON.parse(text); } catch { continue; }
        out.push(...rowsOf(`${dir}/${name}`, value));
    }
    return out;
}

const inside = (root: string, path: string): boolean => {
    const rel = relative(root, path);
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};

/** The guard's: the workspace went, moved, slept or was redocked while it was being read. Whoever interrupted it owns the verdict now. */
export class TrustReadInterrupted extends Error {
    constructor() { super('workspace trust read interrupted; redock it first'); }
}

/** How many times one call reads a workspace's list when another verdict landed while it was reading. Then it stops, and nothing it read says "trusted". */
const READS_WHEN_CROSSED = 3;

/**
 * A workspace's list, and whether it was read ALONE: no other verdict of that workspace was written while it was being read.
 * `fresher`: the read gave up crossed, and a verdict from a reading made alone was kept after this read began (Tynn #364).
 */
interface ListRead { readonly list: TrustList; readonly alone: boolean; readonly fresher?: TrustView }

/**
 * A kept verdict. `seq`: the write count when it was kept (`#writes`), which orders it against every read by the count, never by
 * a clock. `lone`: it came from a reading made alone, or from the person's yes: a complete verdict, not a crossed one.
 */
interface Kept { readonly path: string; readonly view: TrustView; readonly seq: number; readonly lone: boolean }

export class WorkspaceTrust {
    readonly #ports: WorkspaceTrustPorts;
    readonly #views = new Map<string, Kept>();
    /**
     * EVERY WRITE OF A WORKSPACE'S VERDICT, COUNTED (Tynn #955). Several things read one workspace at once (the hosting's
     * pass, the watcher, an agent's start, Genie's own writes, the person's Untrust), a read takes several steps, and
     * whichever landed last used to be kept: a read that found "no file" before the file existed could land after the
     * read that saw it, and "nothing would run" is a yes. A read knows by this count that another verdict landed while it
     * was reading; then what it read may be the older of the two, and it is not kept (`#read`).
     */
    readonly #writes = new Map<string, number>();
    readonly #redockEpoch = new Map<string, symbol>();
    readonly #redocking = new Set<string>();
    readonly #trustedListeners = new Set<(workspaceId: string) => void>();

    constructor(ports: WorkspaceTrustPorts) {
        this.#ports = ports;
    }

    /**
     * Read the workspace's files again and answer. The answer is the record's (Tynn #618: trust is given once and stays);
     * the list is read so it can be shown, and decides nothing but whether anything would run at all.
     */
    async refresh(workspaceId: string, purpose?: 'redock'): Promise<TrustView | null> {
        const workspace = this.#ports.workspaces().find((w) => w.id === workspaceId);
        if (!workspace || (workspace.asleep && purpose !== 'redock')) { this.#forget(workspaceId); return null; }
        if (purpose !== 'redock' && this.#redocking.has(workspaceId)) return null;
        if (purpose === 'redock') {
            this.#redockEpoch.set(workspaceId, Symbol());
            this.#redocking.add(workspaceId);
            // Revoke the old yes before the first await, including when this read fails.
            this.#forget(workspaceId);
        }
        const epoch = this.#redockEpoch.get(workspaceId);
        const ensure = this.#guard(workspaceId, workspace.path, epoch, purpose);
        const ports = this.#guardedPorts(ensure);
        try {
            const read = await this.#read(workspaceId, workspace.path, ports, ensure);
            if (read.fresher) return read.fresher;
            const view = this.#verdict(workspaceId, read);
            this.#keep(workspaceId, workspace.path, view, read.alone);
            return view;
        } catch (error) {
            this.#notRead(workspaceId, error);
            throw error;
        } finally {
            if (purpose === 'redock' && this.#redockEpoch.get(workspaceId) === epoch) this.#redocking.delete(workspaceId);
        }
    }

    /** The person says yes to the workspace. Recorded first: a save that fails leaves it untrusted, and says why. What is kept beside the yes is the list's hash as it was then, for the record only: nothing is ever compared with it. */
    async trust(workspaceId: string): Promise<TrustView | null> {
        const workspace = this.#ports.workspaces().find((w) => w.id === workspaceId);
        if (!workspace || workspace.asleep) { this.#forget(workspaceId); return null; }
        if (this.#redocking.has(workspaceId)) return null;
        const ensure = this.#guard(workspaceId, workspace.path, this.#redockEpoch.get(workspaceId));
        // Read once: the yes is the record's, so a list crossed by another read only shows a moment older.
        const list = await readTrustList(workspace.path, this.#guardedPorts(ensure)).catch((error: unknown) => { this.#notRead(workspaceId, error); throw error; });
        ensure();
        await this.#ports.recordWorkspace(workspaceId, trustHash(list));
        ensure();
        await this.#ports.approveSites(workspaceId);
        ensure();
        const view: TrustView = { trusted: true, changed: false, list };
        this.#keep(workspaceId, workspace.path, view, true);
        // Told after the yes is kept (Tynn #756, PR9b): what waited for it is restored. One listener failing costs nobody the yes or the next listener.
        for (const listener of [...this.#trustedListeners]) { try { listener(workspaceId); } catch { /* the yes stands */ } }
        return view;
    }

    /** Told each time the person says yes to a workspace (and only then: not a refresh, not an Untrust). */
    onTrusted(listener: (workspaceId: string) => void): () => void {
        this.#trustedListeners.add(listener);
        return () => { this.#trustedListeners.delete(listener); };
    }

    /** The person takes the yes back: the only thing that ends a workspace's trust. Forgotten first: a save that fails leaves it trusted, and says why. `null` = no such workspace here. */
    async untrust(workspaceId: string): Promise<TrustView | null> {
        const workspace = this.#ports.workspaces().find((w) => w.id === workspaceId);
        if (!workspace || workspace.asleep) return null;
        if (this.#redocking.has(workspaceId)) return null;
        const ensure = this.#guard(workspaceId, workspace.path, this.#redockEpoch.get(workspaceId));
        await this.#ports.forgetWorkspace(workspaceId);
        ensure();
        // The yes is gone from the record. If the list cannot be read now, the verdict kept from before must not go on saying it.
        const read = await this.#read(workspaceId, workspace.path, this.#guardedPorts(ensure), ensure).catch((error: unknown) => { this.#notRead(workspaceId, error); throw error; });
        if (read.fresher) return read.fresher;
        const view = this.#verdict(workspaceId, read);
        this.#keep(workspaceId, workspace.path, view, read.alone);
        return view;
    }

    /**
     * The workspace's list, read until one reading was made ALONE. A reading during which another verdict of this
     * workspace was written may be older than that verdict's (it does not matter which of the two started first: each
     * reads its files in its own time), so it is read again. Every verdict kept from a reading made alone comes from one
     * that began after the verdict before it was written, so a later one is never replaced by an earlier one. Crossed
     * `READS_WHEN_CROSSED` times, it stops and says so: `#verdict` then takes the record's yes and nothing else.
     *
     * UNLESS A FRESHER COMPLETE VERDICT IS ALREADY KEPT (Tynn #364). Each crossing is a verdict written while this read ran.
     * When the one kept now came from a reading made alone (or the person's yes) and was kept AFTER this read began (by the
     * write count), it is a complete read at least as fresh as anything this one read: it is the answer, and this read
     * keeps nothing over it. A workspace just added, read at once by the hosting's pass, a file write and an agent's start,
     * was left "not trusted" by the last of them, over three reads that each read alone that nothing would run.
     * Otherwise (nothing kept since, a forget, or a kept verdict that was itself crossed) it is as before.
     */
    async #read(workspaceId: string, path: string, ports: TrustListPorts, ensure: () => void): Promise<ListRead> {
        const began = this.#writes.get(workspaceId) ?? 0;
        for (let reading = 1; ; reading++) {
            const before = this.#writes.get(workspaceId) ?? 0;
            const list = await readTrustList(path, ports);
            ensure();
            const alone = (this.#writes.get(workspaceId) ?? 0) === before;
            if (alone) return { list, alone };
            if (reading === READS_WHEN_CROSSED) {
                const kept = this.#views.get(workspaceId);
                const fresher = kept !== undefined && kept.lone && kept.path === path && kept.seq > began ? kept.view : undefined;
                return { list, alone, ...(fresher ? { fresher } : {}) };
            }
        }
    }

    /** The record's yes stands whatever was read. "Nothing would run" is a yes only from a list read alone: a crossed reading may be from before a file arrived. */
    #verdict(workspaceId: string, read: ListRead): TrustView {
        const record = this.#ports.record();
        const verdict = trustVerdict(record, workspaceId, trustHash(read.list));
        return { ...verdict, trusted: verdict.trusted && (read.alone || recordSaysYes(record, workspaceId)), list: read.list };
    }

    /**
     * A read failed (a file held while it is written: EBUSY or EPERM on Windows). What could not be read is not trusted
     * until a read succeeds: a verdict kept as "trusted, nothing would run" does not stand over a workspace that cannot
     * be read now. The person's yes is the record's and stays (Tynn #618); a verdict that already says no stays, with its
     * list to show. An interrupted read is the interrupter's to answer (`#guard`).
     */
    #notRead(workspaceId: string, error: unknown): void {
        if (error instanceof TrustReadInterrupted) return;
        if (this.#views.get(workspaceId)?.view.trusted === true && !recordSaysYes(this.#ports.record(), workspaceId)) this.#forget(workspaceId);
    }

    #keep(workspaceId: string, path: string, view: TrustView, lone: boolean): void {
        const before = this.#views.get(workspaceId)?.view.trusted;
        const seq = (this.#writes.get(workspaceId) ?? 0) + 1;
        this.#views.set(workspaceId, { path, view, seq, lone });
        this.#writes.set(workspaceId, seq);
        if (before !== view.trusted) this.#ports.verdictMoved?.(workspaceId);
    }

    #forget(workspaceId: string): void {
        this.#writes.set(workspaceId, (this.#writes.get(workspaceId) ?? 0) + 1);
        if (this.#views.delete(workspaceId)) this.#ports.verdictMoved?.(workspaceId);
    }

    #guard(workspaceId: string, path: string, epoch: symbol | undefined, purpose?: 'redock'): () => void {
        return () => {
            const current = this.#ports.workspaces().find((w) => w.id === workspaceId);
            if (!current || current.path !== path || this.#redockEpoch.get(workspaceId) !== epoch || (purpose !== 'redock' && (current.asleep || this.#redocking.has(workspaceId)))) {
                if (this.#redockEpoch.get(workspaceId) === epoch) this.#forget(workspaceId);
                throw new TrustReadInterrupted();
            }
        };
    }

    #guardedPorts(ensure: () => void): TrustListPorts {
        return {
            readText: (path) => { ensure(); return this.#ports.readText(path); },
            gitConfig: (path) => { ensure(); return this.#ports.gitConfig(path); },
            ...(this.#ports.listDir ? { listDir: (dir: string) => { ensure(); return this.#ports.listDir!(dir); } } : {}),
            ...(this.#ports.isTracked ? { isTracked: (root: string, path: string) => { ensure(); return this.#ports.isTracked!(root, path); } } : {}),
        };
    }

    /**
     * THE PERSON'S OWN YES, AS IT IS NOW (Tynn #364): the record's, which nothing but their Untrust ends (Tynn #618), so it
     * needs no reading of the workspace's files to be current. A workspace trusted only because nothing in it would run is
     * not this: that verdict is only as fresh as its last read. Asleep, being redocked, or no workspace: no.
     */
    durable(workspaceId: string): boolean {
        const workspace = this.#ports.workspaces().find((w) => w.id === workspaceId);
        return workspace !== undefined && !workspace.asleep && !this.#redocking.has(workspaceId) && recordSaysYes(this.#ports.record(), workspaceId);
    }

    /** `durable`, for the workspace holding `path`: the first one, as `isTrustedPath` finds it. */
    durablePath(path: string): boolean {
        for (const workspace of this.#ports.workspaces()) {
            if (inside(workspace.path, path)) return this.durable(workspace.id);
        }
        return false;
    }

    /** As last read. A workspace not read yet is not trusted; nor is a folder in none. */
    isTrustedPath(path: string): boolean {
        for (const workspace of this.#ports.workspaces()) {
            if (inside(workspace.path, path)) return this.view(workspace.id)?.trusted === true;
        }
        return false;
    }

    view(workspaceId: string): TrustView | null {
        const workspace = this.#ports.workspaces().find((w) => w.id === workspaceId);
        const cached = this.#views.get(workspaceId);
        return workspace && !workspace.asleep && !this.#redocking.has(workspaceId) && cached?.path === workspace.path ? cached.view : null;
    }
}
