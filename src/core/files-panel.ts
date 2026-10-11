import type { ToolKind } from './stream-event.js';

/**
 * THE WORKSPACE FILE PANEL'S MODEL (§4.3) — pure. One panel per workspace. Attribution comes from
 * the agents' OWN edit events, never from guessing: a file that changed on disk with no report is
 * neutral with a `?`. A file shows ONE dot plus a COUNT, never one dot per agent. `rawInput` is
 * untrusted — a `file_path` outside the workspace root produces no marker and no error row. The
 * Changes section is ABSENT, not empty, when nothing changed. Genie never fakes line counts or
 * per-line presence: line ranges are not on the wire, so this model has none.
 */

/** Above this Genie refuses to open a file, in words with its size, rather than show a blank editor. */
export const FILE_SIZE_CAP = 8 * 1024 * 1024;

export interface TreeNode {
    readonly id: string;
    readonly label: string;
    readonly type: 'file' | 'folder';
    readonly ext?: string;
    readonly children?: TreeNode[];
}

export interface Entry {
    /** Relative to the workspace root, forward slashes. */
    readonly path: string;
    readonly kind: 'file' | 'dir';
}

export interface FileEvent {
    readonly agentId: string;
    readonly agentName: string;
    readonly toolKind: ToolKind | null;
    readonly status: 'pending' | 'in_progress' | 'completed' | 'failed' | null;
    readonly rawInput: unknown;
}

export interface FileAttribution {
    readonly path: string;
    /** Every agent with an edit on the file this session — ONE dot plus this count in the tree. */
    readonly agents: ReadonlyArray<{ id: string; name: string }>;
    readonly count: number;
    /** Some agent's edit is in progress right now (violet); otherwise changed this session (green). */
    readonly inFlight: boolean;
}

export interface Activity {
    readonly agent: string;
    readonly verb: 'writing' | 'reading';
    readonly path: string;
}

export interface ChangedGroup {
    /** `you`, an agent's name, or `?` for changes nobody reported. */
    readonly who: string;
    readonly files: readonly string[];
}

const isAbsolute = (p: string) => p.startsWith('/') || /^[A-Za-z]:\//.test(p);

/** Posix-style normalisation by hand, so the result is the same on every OS. `..` above the top is kept, so it can be refused. */
function normalise(p: string): string {
    const slashed = p.replace(/\\/g, '/');
    const drive = /^[A-Za-z]:\//.exec(slashed)?.[0] ?? (slashed.startsWith('/') ? '/' : '');
    const out: string[] = [];
    for (const seg of slashed.slice(drive.length).split('/')) {
        if (seg === '' || seg === '.') continue;
        if (seg === '..') {
            if (out.length > 0 && out[out.length - 1] !== '..') out.pop();
            else out.push('..');
            continue;
        }
        out.push(seg);
    }
    return drive.toLowerCase() + out.join('/');
}

/** The path relative to the root, or `null` for anything outside it — never an error. */
export function confine(root: string, path: string): string | null {
    const rootN = normalise(root);
    const full = normalise(isAbsolute(path.replace(/\\/g, '/')) ? path : `${root}/${path}`);
    if (full === rootN) return '';
    const prefix = rootN.endsWith('/') ? rootN : `${rootN}/`;
    return full.startsWith(prefix) ? full.slice(prefix.length) : null;
}

const byName = (a: TreeNode, b: TreeNode) => (a.type === b.type ? a.label.localeCompare(b.label, 'en', { sensitivity: 'base' }) : a.type === 'folder' ? -1 : 1);

export function buildTree(entries: readonly Entry[]): TreeNode[] {
    interface Mutable { id: string; label: string; type: 'file' | 'folder'; ext?: string; children?: Mutable[]; map?: Map<string, Mutable> }
    const rootMap = new Map<string, Mutable>();
    const folder = (parts: string[]): Map<string, Mutable> => {
        let map = rootMap;
        let id = '';
        for (const part of parts) {
            id = id ? `${id}/${part}` : part;
            let node = map.get(part);
            if (!node) { node = { id, label: part, type: 'folder', children: [], map: new Map() }; map.set(part, node); }
            else if (node.type !== 'folder') { node.type = 'folder'; node.children = []; node.map = new Map(); delete node.ext; }
            map = node.map!;
        }
        return map;
    };
    for (const e of entries) {
        const parts = e.path.split('/').filter(Boolean);
        if (parts.length === 0) continue;
        if (e.kind === 'dir') { folder(parts); continue; }
        const name = parts[parts.length - 1]!;
        const map = folder(parts.slice(0, -1));
        if (map.has(name)) continue;
        const dot = name.lastIndexOf('.');
        map.set(name, { id: parts.join('/'), label: name, type: 'file', ...(dot > 0 ? { ext: name.slice(dot + 1) } : {}) });
    }
    const finish = (map: Map<string, Mutable>): TreeNode[] =>
        [...map.values()].map((n): TreeNode => (n.type === 'folder' ? { id: n.id, label: n.label, type: 'folder', children: finish(n.map!) } : { id: n.id, label: n.label, type: 'file', ...(n.ext ? { ext: n.ext } : {}) })).sort(byName);
    return finish(rootMap);
}

function pathOf(event: FileEvent, root: string): string | null {
    const input = event.rawInput;
    if (typeof input !== 'object' || input === null) return null;
    const raw = (input as { file_path?: unknown }).file_path;
    if (typeof raw !== 'string' || raw.length === 0) return null;
    const confined = confine(root, raw);
    return confined === null || confined === '' ? null : confined;
}

/** The latest status per (agent, file) wins — a tool_call_update completes the call it belongs to. */
function latest(events: readonly FileEvent[], root: string, kind: ToolKind): Map<string, { agentId: string; agentName: string; path: string; status: FileEvent['status'] }> {
    const last = new Map<string, { agentId: string; agentName: string; path: string; status: FileEvent['status'] }>();
    for (const e of events) {
        if (e.toolKind !== kind) continue;
        const path = pathOf(e, root);
        if (path === null) continue;
        last.set(`${e.agentId}\0${path}`, { agentId: e.agentId, agentName: e.agentName, path, status: e.status });
    }
    return last;
}

export function attributionFrom(events: readonly FileEvent[], root: string): Map<string, FileAttribution> {
    const out = new Map<string, { path: string; agents: Array<{ id: string; name: string }>; inFlight: boolean }>();
    for (const e of latest(events, root, 'edit').values()) {
        if (e.status !== 'in_progress' && e.status !== 'completed') continue;
        const a = out.get(e.path) ?? { path: e.path, agents: [], inFlight: false };
        a.agents.push({ id: e.agentId, name: e.agentName });
        if (e.status === 'in_progress') a.inFlight = true;
        out.set(e.path, a);
    }
    return new Map([...out.entries()].map(([k, v]) => [k, { path: v.path, agents: v.agents, count: v.agents.length, inFlight: v.inFlight }]));
}

/** Who is touching what right now, for the footer: edits in progress are `writing`, reads in progress `reading`. */
export function activityFrom(events: readonly FileEvent[], root: string): Activity[] {
    const out: Activity[] = [];
    for (const e of latest(events, root, 'edit').values()) if (e.status === 'in_progress') out.push({ agent: e.agentName, verb: 'writing', path: e.path });
    for (const e of latest(events, root, 'read').values()) if (e.status === 'in_progress') out.push({ agent: e.agentName, verb: 'reading', path: e.path });
    return out;
}

/** Files that changed on disk with NO agent report — shown neutral with a `?`; Genie does not guess the author. */
export function unreportedChanges(attribution: ReadonlyMap<string, FileAttribution>, changedOnDisk: readonly string[], root: string): string[] {
    const out: string[] = [];
    for (const raw of changedOnDisk) {
        const path = confine(root, raw);
        if (path === null || path === '') continue;
        if (!attribution.has(path) && !out.includes(path)) out.push(path);
    }
    return out;
}

const sorted = (files: Iterable<string>) => [...new Set(files)].sort((a, b) => a.localeCompare(b, 'en'));

/** The Changed filter: files grouped by who changed them, you included; `null` when nothing changed (absent, not empty). */
export function changedGroups(attribution: ReadonlyMap<string, FileAttribution>, extra: { mine: readonly string[]; unreported: readonly string[] }): ChangedGroup[] | null {
    const byAgent = new Map<string, string[]>();
    for (const a of attribution.values()) for (const agent of a.agents) byAgent.set(agent.name, [...(byAgent.get(agent.name) ?? []), a.path]);
    const groups: ChangedGroup[] = [];
    if (extra.mine.length > 0) groups.push({ who: 'you', files: sorted(extra.mine) });
    for (const name of [...byAgent.keys()].sort((a, b) => a.localeCompare(b, 'en'))) groups.push({ who: name, files: sorted(byAgent.get(name)!) });
    if (extra.unreported.length > 0) groups.push({ who: '?', files: sorted(extra.unreported) });
    return groups.length === 0 ? null : groups;
}

/** Honest size words: never "0 MB" for a small file that still broke a small cap. */
function sizeWords(bytes: number): string {
    if (bytes >= 1024 * 1024) return `${Math.round(bytes / (1024 * 1024))} MB`;
    if (bytes >= 1024) return `${Math.round(bytes / 1024)} kB`;
    return `${bytes} B`;
}

export function openRefusal(sizeBytes: number, cap: number = FILE_SIZE_CAP): string | null {
    if (sizeBytes < cap) return null;
    return `this file is ${sizeWords(sizeBytes)}; Genie will not open it`;
}
