import { formatRoute, parseRoute } from './route.js';
import type { ToolKind } from './stream-event.js';
import { editLineCounts, joinToolCalls, type TimedEvent } from './stream-view.js';

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
    /** When the row arrived (the ledger's time); absent or null = not timed. */
    readonly at?: number | null | undefined;
}

export interface FileAttribution {
    readonly path: string;
    /** Every agent with an edit on the file this session — ONE dot plus this count in the tree. */
    readonly agents: ReadonlyArray<{ id: string; name: string }>;
    readonly count: number;
    /** Some agent's edit is in progress right now (violet); otherwise changed this session (green). */
    readonly inFlight: boolean;
    /** The latest reported edit's arrival time (the board's time column); `null` when no edit row was timed. Absent on an older snapshot. */
    readonly changedAt?: number | null | undefined;
    /**
     * Lines added / removed this session, summed over the COMPLETED edit calls that carried a real before-and-after
     * (`old_string` / `new_string`, or an `edits[]` list). `null` when none did — a `Write` reports only what it
     * wrote. Never estimated, never `0` from nothing. Absent on an older snapshot.
     */
    readonly plus?: number | null | undefined;
    readonly minus?: number | null | undefined;
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
/** The file the panel should open for the route: the route's file when it is not the one already open; else nothing. */
export function routeFileToOpen(routeFile: string | null, openPath: string | null): string | null {
    return routeFile !== null && routeFile !== openPath ? routeFile : null;
}

export function confine(root: string, path: string): string | null {
    const rootN = normalise(root);
    const full = normalise(isAbsolute(path.replace(/\\/g, '/')) ? path : `${root}/${path}`);
    if (full === rootN) return '';
    const prefix = rootN.endsWith('/') ? rootN : `${rootN}/`;
    return full.startsWith(prefix) ? full.slice(prefix.length) : null;
}

const byName = (a: TreeNode, b: TreeNode) => (a.type === b.type ? a.label.localeCompare(b.label, 'en', { sensitivity: 'base' }) : a.type === 'folder' ? -1 : 1);

/**
 * Whether the open file is re-read after a batch of changes (genie#921): only when it is one of them — Genie 1 reloaded
 * EXACTLY the open tabs that changed. A notification without paths (a host from before batching) re-reads it.
 */
export function reloadsOpenFile(openPath: string, changed: readonly string[] | undefined): boolean {
    return changed === undefined || changed.includes(openPath);
}

/** Where openFileForUser lands (genie#922): that workspace, its file panel open on the file. Built by the router, never by hand. */
export function openFileRoute(workspaceId: string, path: string): string {
    const base = parseRoute(`genie://workspace/${encodeURIComponent(workspaceId)}?files=`);
    return base.surface === 'workspace' ? formatRoute({ ...base, panel: 'files', file: path }) : `genie://workspace/${encodeURIComponent(workspaceId)}`;
}

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

/**
 * An agent's ledger rows as FILE EVENTS, one per tool call (the owner, 2026-10-14: the Changes tab never showed the
 * agent's changes). A call is several rows: the `tool_call` names its kind (`edit`) while its input is still empty, and
 * the `tool_call_update`s carry the input and the status but no kind. Read row by row, no row was ever both an edit and
 * in progress or completed, so a Claude agent's 161 edits in one session were attributed to nobody. The rows are folded
 * per call first (`joinToolCalls`, the Stream's own fold): kind and input from the frame that said them, status from
 * the latest.
 */
export function fileEventsOf(rows: readonly TimedEvent[], agent: { id: string; name: string }): FileEvent[] {
    return joinToolCalls(rows).flatMap((row): FileEvent[] =>
        row.event.kind === 'tool' ? [{ agentId: agent.id, agentName: agent.name, toolKind: row.event.toolKind, status: row.event.status, rawInput: row.event.rawInput, at: row.at }] : []);
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
    // The time and the counts, over EVERY edit row on a file this session (not only the latest per agent): the time
    // is the latest reported edit's; the counts sum the completed calls that carried a real before-and-after.
    const detail = new Map<string, { changedAt: number | null; plus: number | null; minus: number | null }>();
    for (const e of events) {
        if (e.toolKind !== 'edit' || (e.status !== 'in_progress' && e.status !== 'completed')) continue;
        const path = pathOf(e, root);
        if (path === null || !out.has(path)) continue;
        const d = detail.get(path) ?? { changedAt: null, plus: null, minus: null };
        if (typeof e.at === 'number' && (d.changedAt === null || e.at > d.changedAt)) d.changedAt = e.at;
        const counts = e.status === 'completed' ? editLineCounts(e.rawInput) : null;
        if (counts) { d.plus = (d.plus ?? 0) + counts.plus; d.minus = (d.minus ?? 0) + counts.minus; }
        detail.set(path, d);
    }
    return new Map([...out.entries()].map(([k, v]) => {
        const d = detail.get(k) ?? { changedAt: null, plus: null, minus: null };
        return [k, { path: v.path, agents: v.agents, count: v.agents.length, inFlight: v.inFlight, changedAt: d.changedAt, plus: d.plus, minus: d.minus }];
    }));
}

/** Who is touching what right now, for the footer: edits in progress are `writing`, reads in progress `reading`. */
export function activityFrom(events: readonly FileEvent[], root: string): Activity[] {
    const out: Activity[] = [];
    for (const e of latest(events, root, 'edit').values()) if (e.status === 'in_progress') out.push({ agent: e.agentName, verb: 'writing', path: e.path });
    for (const e of latest(events, root, 'read').values()) if (e.status === 'in_progress') out.push({ agent: e.agentName, verb: 'reading', path: e.path });
    return out;
}

/** Files that changed on disk with NO agent report — shown neutral with a `?`; Genie does not guess the author. */
/**
 * Whether a watcher event is a CHANGE: a write at or after the watch started (`mtimeMs >= since`), or a
 * deletion (`info === null`). A write that PREDATES the watch is not — macOS FSEvents replays events for
 * writes made shortly before the watcher attached, and marking those "changed on disk" invented an
 * unreported change that no one made while Genie was looking. A directory is never a change (Windows
 * reports the parent directories of a written file).
 */
export function countsAsDiskChange(info: { readonly mtimeMs: number; readonly isDirectory: boolean } | null, since: number): boolean {
    if (info === null) return true;
    if (info.isDirectory) return false;
    return info.mtimeMs >= since;
}

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

/** The crumb over the editor (the board): the path, segment by segment. */
export function fileCrumb(path: string): string[] {
    return path.split('/').filter((seg) => seg.length > 0);
}

const LANGUAGES: Readonly<Record<string, string>> = {
    php: 'PHP', ts: 'TypeScript', tsx: 'TypeScript', js: 'JavaScript', jsx: 'JavaScript', mjs: 'JavaScript', cjs: 'JavaScript',
    json: 'JSON', md: 'Markdown', css: 'CSS', html: 'HTML', py: 'Python', go: 'Go', rs: 'Rust', yml: 'YAML', yaml: 'YAML',
    sh: 'Shell', sql: 'SQL', toml: 'TOML', xml: 'XML', svg: 'SVG', txt: 'Plain text',
};

export interface StatusBar {
    readonly language: string;
    readonly eol: 'LF' | 'CRLF';
    readonly encoding: string;
    /** `you and atlas in this file` — you, because the file is open here; the agents with an edit or a read in flight on it. */
    readonly presence: string;
}

/**
 * The status bar under the editor (the board: `PHP · LF · UTF-8 · you and atlas in this file`). Each part a fact
 * Genie holds: the extension, the text's line endings, the encoding it decoded, who is in the file. No cursor
 * position — the viewer reports none, and a made-up `Ln, Col` would be a lie about where the reader is.
 */
export function statusBarFor(path: string, text: string, activity: readonly Activity[]): StatusBar {
    const name = path.split('/').pop() ?? path;
    const dot = name.lastIndexOf('.');
    const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
    const language = ext === '' ? 'Plain text' : (LANGUAGES[ext] ?? ext.toUpperCase());
    const eol: 'LF' | 'CRLF' = text.includes('\r\n') ? 'CRLF' : 'LF';
    const others = [...new Set(activity.filter((a) => a.path === path).map((a) => a.agent))];
    const who = ['you', ...others];
    const list = who.length <= 2 ? who.join(' and ') : `${who.slice(0, -1).join(', ')} and ${who[who.length - 1]}`;
    return { language, eol, encoding: 'UTF-8', presence: `${list} in this file` };
}
