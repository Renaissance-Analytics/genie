import { formatLike } from './envelope-sites.js';
import { savePathProblem, scanForMachineState, type GuardViolation } from './workspace-save-guard.js';
import { SCHEMA_REVISION, stampSchema } from './workspace-model.js';

/**
 * SAVE TO REPO, THE PURE HALF (Tynn #756). The owner, 2026-11-16: a "Save to repo" button with a diff, mindful of
 * UPSTREAM changes when a team shares one workspace across workstations (fetch first; show incoming; merge per element;
 * surface conflicts; never overwrite a teammate's change blindly). The save is an ordinary git change the person commits.
 *
 * - {@link planSave}: the live model -> the files a save would write, or the reasons it refuses (the guard, a newer schema).
 * - {@link diffFiles}: planned files against what is on disk.
 * - {@link elementsOf} / {@link mergeElements} / {@link applyMerge}: the three-way merge, per ELEMENT (a site, an agent, a
 *   service, one flow file...), never per line: an element is what a person thinks of as one thing.
 */

export interface SaveFile {
    readonly path: string;
    readonly text: string;
}

/** What Genie holds now, already turned into repo shapes by each element's own writer. */
export interface LiveModel {
    /** project.json as an object, with this save's changes applied. */
    readonly manifest: Record<string, unknown>;
    /** project.json as it is on disk now (its indentation, line endings and trailing newline are kept). */
    readonly manifestText: string;
    /** Element files: `.flows/<n>.json`, `.processes/<n>.json`, `.genie/tabs.json`. */
    readonly files: readonly { readonly path: string; readonly value: unknown }[];
}

export type SavePlan =
    | { ok: true; files: SaveFile[]; backups: SaveFile[]; stampedTo: string | null }
    | { ok: false; reason: string; violations: GuardViolation[] };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function compare(a: string, b: string): number {
    const pa = a.split('.').map(Number);
    const pb = b.split('.').map(Number);
    for (let i = 0; i < 3; i++) {
        const d = (pa[i] ?? 0) - (pb[i] ?? 0);
        if (d !== 0) return d;
    }
    return 0;
}

/** The schema revision a manifest's keys need: `services`, `workspace` and an agent's `issueWatch` arrived in 0.5.0. */
export function requiredRevision(manifest: Record<string, unknown>): string {
    if ('services' in manifest || 'workspace' in manifest) return '0.5.0';
    const agents = manifest.agents;
    if (isRecord(agents) && Object.values(agents).some((a) => isRecord(a) && 'issueWatch' in a)) return '0.5.0';
    return '0.4.0';
}

const refuse = (reason: string, violations: GuardViolation[] = []): SavePlan => ({ ok: false, reason, violations });

/**
 * The files a save would write. Nothing is written here. Refused as a whole (never part of it) when anything holds a
 * machine, a file is outside the places a save writes, the manifest is on a schema newer than this writer's, or its keys
 * need a revision this writer does not yet write.
 */
export function planSave(model: LiveModel, options: { revision?: string } = {}): SavePlan {
    const revision = options.revision ?? SCHEMA_REVISION;
    for (const file of model.files) {
        const problem = savePathProblem(file.path);
        if (problem !== null) return refuse(problem);
    }
    const violations = [
        ...scanForMachineState(model.manifest, 'project.json'),
        ...model.files.flatMap((f) => scanForMachineState(f.value, f.path)),
    ];
    if (violations.length > 0) return refuse(`Nothing was saved. ${violations.map((v) => v.reason).join('; ')}`, violations);

    const needs = requiredRevision(model.manifest);
    if (compare(needs, revision) > 0) return refuse(`project.json uses keys from schema ${needs}, and this Genie writes ${revision}; nothing was saved`);
    const stamp = stampSchema(model.manifest, revision);
    if (!stamp.ok) return refuse(stamp.reason);

    const usesNewer = compare(needs, '0.4.0') > 0;
    const manifest = usesNewer ? stamp.manifest : model.manifest;
    const stamped = usesNewer && stamp.manifest !== model.manifest;
    const files: SaveFile[] = [{ path: 'project.json', text: formatLike(model.manifestText, manifest) }];
    for (const f of model.files) files.push({ path: f.path, text: `${JSON.stringify(f.value, null, 2)}\n` });
    const backups = stamped && stamp.from === null ? [{ path: `project.json.pre-schema-${revision}.bak`, text: model.manifestText }] : [];
    return { ok: true, files, backups, stampedTo: stamped ? revision : null };
}

export type FileStatus = 'added' | 'changed' | 'unchanged';

/** Each planned file against what is on disk (`null` = not there). */
export function diffFiles(files: readonly SaveFile[], onDisk: ReadonlyMap<string, string | null>): { path: string; status: FileStatus }[] {
    return files.map((f) => {
        const there = onDisk.get(f.path) ?? null;
        return { path: f.path, status: there === null ? 'added' : there === f.text ? 'unchanged' : 'changed' };
    });
}

/** Key order must not matter to equality: two sides that wrote the same element in a different order did not disagree. */
function canon(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(canon).join(',')}]`;
    if (isRecord(value)) return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canon(value[k])}`).join(',')}}`;
    return value === undefined ? 'undefined' : JSON.stringify(value);
}

/** A service's identity inside the `services` array: engine, then variant, then a custom service's name. */
const serviceId = (s: unknown): string => {
    if (!isRecord(s)) return '?';
    return [s.engine, s.variant, s.name].filter((p): p is string => typeof p === 'string' && p !== '').join(':');
};

const MAP_KEYS: ReadonlySet<string> = new Set(['sites', 'agents']);

/**
 * A file as its elements. project.json: one per site, agent and service, and one per other key (`$schema` is the stamp,
 * not an element). Any other file: one element, the file. An unreadable file is one element holding its text, so a
 * merge can still say it differs.
 */
export function elementsOf(path: string, text: string | null): Map<string, unknown> {
    const out = new Map<string, unknown>();
    if (text === null) return out;
    let value: unknown;
    try { value = JSON.parse(text); } catch { out.set(path, text); return out; }
    if (path !== 'project.json' || !isRecord(value)) { out.set(path, value); return out; }
    for (const [key, v] of Object.entries(value)) {
        if (key === '$schema') continue;
        if (MAP_KEYS.has(key) && isRecord(v)) {
            for (const [k, item] of Object.entries(v)) out.set(`project.json#${key}/${k}`, item);
        } else if (key === 'services' && Array.isArray(v)) {
            for (const item of v) out.set(`project.json#services/${serviceId(item)}`, item);
        } else out.set(`project.json#${key}`, v);
    }
    return out;
}

export type MergeKind = 'same' | 'local' | 'incoming' | 'conflict';

export interface MergeDecision {
    readonly id: string;
    readonly kind: MergeKind;
    readonly base: unknown;
    readonly local: unknown;
    readonly incoming: unknown;
}

/**
 * The three-way merge, per element. `base` is the file at the merge-base with upstream, `local` what this save would
 * write, `incoming` the file upstream. An element only we changed is `local`; only they changed is `incoming` (a removal
 * included); the same on both sides is `same`; changed on both to different values is a `conflict`, which is the
 * person's to settle: nothing here picks a side.
 */
export function mergeElements(input: { base: ReadonlyMap<string, string | null>; local: ReadonlyMap<string, string | null>; incoming: ReadonlyMap<string, string | null> }): MergeDecision[] {
    const paths = [...new Set([...input.local.keys(), ...input.incoming.keys(), ...input.base.keys()])];
    const out: MergeDecision[] = [];
    for (const path of paths) {
        const b = elementsOf(path, input.base.get(path) ?? null);
        const l = elementsOf(path, input.local.get(path) ?? null);
        const i = elementsOf(path, input.incoming.get(path) ?? null);
        const ids = [...new Set([...l.keys(), ...i.keys(), ...b.keys()])];
        for (const id of ids) {
            const base = b.get(id);
            const local = l.get(id);
            const incoming = i.get(id);
            const kind: MergeKind = canon(local) === canon(incoming) ? 'same' : canon(base) === canon(local) ? 'incoming' : canon(base) === canon(incoming) ? 'local' : 'conflict';
            out.push({ id, kind, base, local, incoming });
        }
    }
    return out;
}

/** Sets (or, for `undefined`, removes) one element of a project.json object. */
function setElement(manifest: Record<string, unknown>, id: string, value: unknown): void {
    const [key, ...rest] = id.slice('project.json#'.length).split('/');
    const sub = rest.join('/');
    if (key === undefined) return;
    if (MAP_KEYS.has(key) && sub !== '') {
        const map = isRecord(manifest[key]) ? { ...(manifest[key] as Record<string, unknown>) } : {};
        if (value === undefined) delete map[sub]; else map[sub] = value;
        manifest[key] = map;
        return;
    }
    if (key === 'services' && sub !== '') {
        const list = Array.isArray(manifest.services) ? [...manifest.services] : [];
        const at = list.findIndex((s) => serviceId(s) === sub);
        if (value === undefined) { if (at >= 0) list.splice(at, 1); } else if (at >= 0) list[at] = value; else list.push(value);
        manifest.services = list;
        return;
    }
    if (value === undefined) delete manifest[key]; else manifest[key] = value;
}

/**
 * `localText` with the merge applied: what only they changed comes in, what only we changed stays, and each conflict
 * takes the person's choice. A conflict with no choice stops the whole apply and is named; nothing is picked for them.
 */
export function applyMerge(path: string, localText: string, decisions: readonly MergeDecision[], choices: Readonly<Record<string, 'local' | 'incoming'>>): { ok: true; text: string } | { ok: false; unresolved: string[] } {
    const mine = decisions.filter((d) => d.id === path || d.id.startsWith(`${path}#`));
    const unresolved = mine.filter((d) => d.kind === 'conflict' && choices[d.id] === undefined).map((d) => d.id);
    if (unresolved.length > 0) return { ok: false, unresolved };
    const takes = mine.filter((d) => d.kind === 'incoming' || (d.kind === 'conflict' && choices[d.id] === 'incoming'));
    if (takes.length === 0) return { ok: true, text: localText };
    let parsed: unknown;
    try { parsed = JSON.parse(localText); } catch { return { ok: true, text: localText }; }
    if (path !== 'project.json' || !isRecord(parsed)) {
        const whole = takes.find((d) => d.id === path);
        return { ok: true, text: whole && whole.incoming !== undefined ? formatLike(localText, whole.incoming) : localText };
    }
    const manifest: Record<string, unknown> = { ...parsed };
    for (const d of takes) setElement(manifest, d.id, d.incoming);
    return { ok: true, text: formatLike(localText, manifest) };
}

/** What the Save to repo dialog is told (Tynn #756): the plan, how each file differs from disk, what upstream did, and every element's merge. */
export interface SavePreview {
    readonly plan: SavePlan;
    readonly files: readonly { path: string; status: FileStatus }[];
    readonly upstream: { fetched: boolean; ref: string | null; reason?: string };
    /** Every element, and whether it is ours, theirs, the same or a conflict. Empty without an upstream. */
    readonly decisions: readonly MergeDecision[];
    /** The ids of the conflicts the person must settle before a save writes. */
    readonly conflicts: readonly string[];
}

export type SaveResult = { ok: true; written: string[] } | { ok: false; reason: string; written: string[] };

/** What a bridge answers: the result, or a host's refusal in words (an older host, a guest, a closed link). */
export type SavePreviewReply = SavePreview | { ok: false; reason: string };
export type SaveReply = SaveResult | { ok: false; reason: string };

/** A conflict's settlement: the side the person kept. */
export type SaveChoices = Readonly<Record<string, 'local' | 'incoming'>>;
