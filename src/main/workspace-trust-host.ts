import { join, relative, isAbsolute } from 'node:path';
import { firstStartWords, readEnvelopeSites, siteRunFingerprint, type ServableSite } from '../core/envelope-sites.js';
import { listRepos } from '../core/repo-registry.js';
import { npmRunTarget, trustHash, trustVerdict, unsafeGitKeys, type GitConfigEntry, type TrustHook, type TrustList, type TrustServer } from '../core/workspace-trust.js';
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
}

export interface TrustView { readonly trusted: boolean; readonly changed: boolean; readonly list: TrustList }

export interface WorkspaceTrustPorts extends TrustListPorts {
    workspaces(): readonly { readonly id: string; readonly path: string; readonly asleep?: boolean }[];
    record(): { readonly carried: readonly string[]; readonly workspaces: Readonly<Record<string, string>> };
    recordWorkspace(workspaceId: string, hash: string): Promise<void>;
    approveSites(workspaceId: string): Promise<void>;
    /** The verdict differs from the last one read, or this is the first. */
    verdictMoved?(workspaceId: string): void;
    /** A pause between two reads of a carried workspace's list (default setTimeout). */
    wait?(ms: number): Promise<void>;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const NOTHING: TrustList = { sites: [], hooks: [], servers: [], gitKeys: [], approvals: [] };
/** A carried workspace's list is re-read up to this many times for two reads in a row that agree, this far apart. */
const SETTLE_READS = 5;
const SETTLE_WAIT_MS = 50;
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
    return { sites, hooks, servers, gitKeys, approvals };
}

const inside = (root: string, path: string): boolean => {
    const rel = relative(root, path);
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};

export class WorkspaceTrust {
    readonly #ports: WorkspaceTrustPorts;
    readonly #views = new Map<string, { path: string; view: TrustView }>();
    readonly #redockEpoch = new Map<string, symbol>();
    readonly #redocking = new Set<string>();

    constructor(ports: WorkspaceTrustPorts) {
        this.#ports = ports;
    }

    /**
     * Read the workspace's files again and answer. Carried over at the upgrade with no list recorded yet: this list is
     * recorded now, once, so a later change asks — and only a SETTLED list (two reads in a row the same): a read taken while
     * the files were being written would record half a list, and the whole one would then read "changed". One that never
     * settles records nothing and is not trusted: the person is asked (genie#1519; the line's flake, run 42277250815).
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
            let list = await readTrustList(workspace.path, ports);
            ensure();
            let hash = trustHash(list);
            const record = this.#ports.record();
            if (record.carried.includes(workspaceId) && record.workspaces[workspaceId] === undefined && hash !== trustHash(NOTHING)) {
                const settled = await this.#settled(workspace.path, hash, ports, ensure);
                ensure();
                if (settled === null) {
                    const unsettled: TrustView = { trusted: false, changed: false, list };
                    this.#keep(workspaceId, workspace.path, unsettled);
                    return unsettled;
                }
                ({ list, hash } = settled);
                if (hash !== trustHash(NOTHING)) await this.#ports.recordWorkspace(workspaceId, hash);
            }
            ensure();
            const view = { ...trustVerdict(this.#ports.record(), workspaceId, hash), list };
            this.#keep(workspaceId, workspace.path, view);
            return view;
        } finally {
            if (purpose === 'redock' && this.#redockEpoch.get(workspaceId) === epoch) this.#redocking.delete(workspaceId);
        }
    }

    /** The list read again until two reads in a row agree: at once, then up to four more, {@link SETTLE_WAIT_MS} apart. `null` = it never settled. */
    async #settled(path: string, firstHash: string, ports: TrustListPorts, ensure: () => void): Promise<{ list: TrustList; hash: string } | null> {
        const wait = this.#ports.wait ?? ((ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); }));
        let before = firstHash;
        for (let i = 0; i < SETTLE_READS; i += 1) {
            ensure();
            if (i > 0) await wait(SETTLE_WAIT_MS);
            ensure();
            const list = await readTrustList(path, ports);
            ensure();
            const hash = trustHash(list);
            if (hash === before) return { list, hash };
            before = hash;
        }
        return null;
    }

    /** The person says yes to what the workspace says now. Recorded first: a save that fails leaves it untrusted, and says why. */
    async trust(workspaceId: string): Promise<TrustView | null> {
        const workspace = this.#ports.workspaces().find((w) => w.id === workspaceId);
        if (!workspace || workspace.asleep) { this.#forget(workspaceId); return null; }
        if (this.#redocking.has(workspaceId)) return null;
        const ensure = this.#guard(workspaceId, workspace.path, this.#redockEpoch.get(workspaceId));
        const list = await readTrustList(workspace.path, this.#guardedPorts(ensure));
        ensure();
        await this.#ports.recordWorkspace(workspaceId, trustHash(list));
        ensure();
        await this.#ports.approveSites(workspaceId);
        ensure();
        const view: TrustView = { trusted: true, changed: false, list };
        this.#keep(workspaceId, workspace.path, view);
        return view;
    }

    #keep(workspaceId: string, path: string, view: TrustView): void {
        const before = this.#views.get(workspaceId)?.view.trusted;
        this.#views.set(workspaceId, { path, view });
        if (before !== view.trusted) this.#ports.verdictMoved?.(workspaceId);
    }

    #forget(workspaceId: string): void {
        if (this.#views.delete(workspaceId)) this.#ports.verdictMoved?.(workspaceId);
    }

    #guard(workspaceId: string, path: string, epoch: symbol | undefined, purpose?: 'redock'): () => void {
        return () => {
            const current = this.#ports.workspaces().find((w) => w.id === workspaceId);
            if (!current || current.path !== path || this.#redockEpoch.get(workspaceId) !== epoch || (purpose !== 'redock' && (current.asleep || this.#redocking.has(workspaceId)))) {
                if (this.#redockEpoch.get(workspaceId) === epoch) this.#forget(workspaceId);
                throw new Error('workspace trust read interrupted; redock it first');
            }
        };
    }

    #guardedPorts(ensure: () => void): TrustListPorts {
        return {
            readText: (path) => { ensure(); return this.#ports.readText(path); },
            gitConfig: (path) => { ensure(); return this.#ports.gitConfig(path); },
            ...(this.#ports.isTracked ? { isTracked: (root: string, path: string) => { ensure(); return this.#ports.isTracked!(root, path); } } : {}),
        };
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
