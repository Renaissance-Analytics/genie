import { isAcpProvider, type AcpProvider } from './engine.js';
import type { MemoryClass, Scope, Source } from '../main/knowledge-store.js';

/**
 * IMPORTING GENIE 1 — pure.
 *
 * The owner upgraded 0.7.0-beta.342 → 2.0.0-beta.5 on 2026-10-11 and saw NO workspaces: Genie 2
 * kept its own empty registry and never read v1's `genie.db` (and the one reader it had looked
 * in `~/.genie`, where v1 never wrote). "Settings that still exist in Genie 2 carry over" was the
 * ruling; workspaces and agents are the settings that matter most. This module decides WHAT is
 * imported from what v1 has; `main/v1-import.ts` reads the database; the composition root applies
 * the plan once and writes a marker so a second boot does not import twice.
 *
 * Rules, each with a test:
 * - v1's `__system__` workspace (its OS agent's home under `~/.gosa`) is not a workspace anybody
 *   has; it is skipped, and so are its agents — Genie 2 seeds its own OS agent.
 * - A workspace whose folder no longer exists is skipped and SAID (the person deleted or moved it;
 *   registering a path Genie cannot open would fault every boot).
 * - A workspace already in the registry (same id) is left alone.
 * - An agent imports when its workspace is imported or already present and its `tui` is one Genie 2
 *   can run (claude, codex); any other tui is skipped with the reason — agents-in-TUIs are excluded
 *   by the ruling, and a record Genie cannot start is a disabled control.
 * - Two v1 agents with the same name in one workspace: the second is skipped (identity is the name).
 * - `persona_path` is absolute in v1; Genie 2 keeps the persona workspace-relative. Inside the
 *   workspace → relative with forward slashes; outside → the persona is dropped and said.
 */

export interface V1Workspace {
    readonly id: string;
    readonly path: string;
    readonly name: string;
    readonly shape: 'agi' | 'simple';
    /** v1's `hibernated_at` is set: nothing may start here, and Genie 2 keeps it asleep (§6.1). */
    readonly hibernated: boolean;
}

export interface V1Agent {
    readonly id: string;
    readonly workspaceId: string;
    readonly name: string;
    readonly tui: string | null;
    readonly personaPath: string | null;
    /** Genie 1's `role`: `'workspace'` marks the workspace's DEFAULT agent. Absent on a v1 database without the column. */
    readonly role?: string | null;
}

/**
 * GENIE 1'S DEFAULT AGENTS, CARRIED OVER (the owner, 2026-10-19). Genie 1 designated a workspace's default agent with
 * `role = 'workspace'` on the agent row; Genie 2 keeps it on the workspace. Matched by (workspace, name), the identity
 * both keep — a v1 default with no Genie 2 record is left out, never guessed.
 */
export function v1DefaultAgents(
    v1: ReadonlyArray<{ readonly workspaceId: string; readonly name: string; readonly role?: string | null }>,
    records: ReadonlyArray<{ readonly id: string; readonly workspaceId: string; readonly name: string }>,
): Record<string, string> {
    const out: Record<string, string> = {};
    for (const a of v1) {
        if (a.role !== 'workspace') continue;
        const record = records.find((r) => r.workspaceId === a.workspaceId && r.name === a.name);
        if (record) out[a.workspaceId] = record.id;
    }
    return out;
}

export interface V1Catalog {
    readonly workspaces: readonly V1Workspace[];
    readonly agents: readonly V1Agent[];
}

export interface ImportedWorkspace {
    readonly id: string;
    readonly path: string;
    readonly asleep: boolean;
}

export interface ImportedAgent {
    readonly workspaceId: string;
    readonly provider: AcpProvider;
    readonly name: string;
    readonly instructions: string | null;
}

export interface V1ImportPlan {
    readonly workspaces: readonly ImportedWorkspace[];
    readonly agents: readonly ImportedAgent[];
    /** Workspaces ALREADY in the registry that v1 had hibernated and Genie 2 has awake: put to sleep, once (beta.7 imported them awake). */
    readonly hibernate: readonly string[];
    /** Every record NOT imported, with the reason — shown, never swallowed. */
    readonly skipped: readonly string[];
}

export const V1_SYSTEM_WORKSPACE = '__system__';

export interface ExistingRegistry {
    readonly workspaces: readonly { readonly id: string; readonly asleep: boolean }[];
    readonly agents: readonly { readonly workspaceId: string; readonly name: string }[];
}

/** v1 stores the persona as an absolute path; Genie 2 keeps it relative to the workspace. */
export function relativePersona(personaPath: string | null, workspacePath: string): string | null {
    if (!personaPath) return null;
    const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '');
    const persona = norm(personaPath);
    const root = norm(workspacePath);
    const lower = (s: string) => (/^[a-z]:\//i.test(s) ? s.toLowerCase() : s);
    if (lower(persona).startsWith(lower(root) + '/')) return persona.slice(root.length + 1);
    return null;
}

export function planV1Import(catalog: V1Catalog | null, existing: ExistingRegistry, pathExists: (path: string) => boolean): V1ImportPlan {
    if (catalog === null) return { workspaces: [], agents: [], hibernate: [], skipped: [] };
    const skipped: string[] = [];
    const workspaces: ImportedWorkspace[] = [];
    const hibernate: string[] = [];
    const known = new Set(existing.workspaces.map((w) => w.id));
    const awake = new Set(existing.workspaces.filter((w) => !w.asleep).map((w) => w.id));
    const byId = new Map<string, V1Workspace>();

    for (const w of catalog.workspaces) {
        if (w.id === V1_SYSTEM_WORKSPACE) { skipped.push(`workspace ${w.name}: v1's system workspace, not imported (Genie 2 has its own OS agent)`); continue; }
        byId.set(w.id, w);
        if (known.has(w.id)) { if (w.hibernated && awake.has(w.id)) hibernate.push(w.id); continue; }
        if (!pathExists(w.path)) { skipped.push(`workspace ${w.name}: its folder ${w.path} no longer exists`); continue; }
        workspaces.push({ id: w.id, path: w.path, asleep: w.hibernated });
        known.add(w.id);
    }

    const agents: ImportedAgent[] = [];
    const taken = new Set(existing.agents.map((a) => `${a.workspaceId}\u0000${a.name}`));
    for (const a of catalog.agents) {
        if (a.workspaceId === V1_SYSTEM_WORKSPACE) { skipped.push(`agent ${a.name}: belonged to v1's system workspace`); continue; }
        if (!known.has(a.workspaceId)) { skipped.push(`agent ${a.name}: its workspace was not imported`); continue; }
        if (!isAcpProvider(a.tui)) { skipped.push(`agent ${a.name}: runs on "${a.tui ?? 'no tui'}", which Genie 2 does not run (claude and codex only)`); continue; }
        const key = `${a.workspaceId}\u0000${a.name}`;
        if (taken.has(key)) { skipped.push(`agent ${a.name}: a second agent of that name in the same workspace`); continue; }
        taken.add(key);
        const ws = byId.get(a.workspaceId);
        const instructions = ws ? relativePersona(a.personaPath, ws.path) : null;
        if (a.personaPath && instructions === null) skipped.push(`agent ${a.name}: persona ${a.personaPath} is outside its workspace; imported without it`);
        agents.push({ workspaceId: a.workspaceId, provider: a.tui, name: a.name, instructions });
    }
    return { workspaces, agents, hibernate, skipped };
}

/*
 * GENIE 1's KNOWLEDGE GRAPH — pure.
 *
 * The owner, 2026-10-14: "the knowledge graph is empty or not rendering for me. We had so much important
 * information in there." v1's `genie.db` held its memories in `knowledge_nodes` / `knowledge_edges`; the
 * import above carried workspaces, agents and settings and never these. This plans what comes over;
 * `main/v1-import.ts` reads the rows; the knowledge store applies the plan once and records that it did.
 *
 * The mapping, each with a test:
 * - The node's id is KEPT. v1's explicit edges point at ids, and Genie 2 resolves an edge's text as an
 *   id first, so a kept id is what makes them land. Ids are UUIDs, so they cannot collide with `kn_…`.
 * - title, body and class carry over; an unknown class becomes `knowledge`, said. Tags are v1's JSON
 *   text, parsed; unreadable tags become none, said. `source` is agent | user (v1 has the same CHECK).
 * - Times are v1's epoch milliseconds; Genie 2 stores ISO strings.
 * - Scope: `system` is `system`. A workspace keeps v1's workspace id — the workspace import keeps v1's
 *   ids too, so the two agree with no lookup table; a memory of a workspace that was not imported (its
 *   folder is gone) keeps its scope and is still found by an `all` search. v1's `__system__` workspace is
 *   its OS agent's home and not a Genie 2 workspace: those memories belong to this machine (`system`).
 *   `gapp` is carried. Anything else is `system`, said.
 * - Edges carry over as v1 wrote them — the text and the kind (`wiki` | `explicit`) — and are resolved
 *   at read time like every Genie 2 edge, so one v1 could not resolve stays visibly unresolved.
 * - Not carried, because Genie 2 has no such thing: v1's sync provenance (`origin*`, `role`, `sort_order`)
 *   and an unaccepted `pending_*` revision (the node imports with the body it actually had), its
 *   `knowledge_origin_tombstones` and `knowledge_link_audit`.
 */

/** A v1 `knowledge_nodes` row, as v1 stores it. */
export interface V1KnowledgeNode {
    readonly id: string;
    readonly title: string;
    readonly body: string;
    /** JSON text, e.g. `["a","b"]`. */
    readonly tags: string;
    readonly source: string;
    readonly class: string;
    readonly scopeKind: string;
    readonly scopeRef: string | null;
    /** Epoch milliseconds. */
    readonly createdAt: number;
    readonly updatedAt: number;
}

/** A v1 `knowledge_edges` row. */
export interface V1KnowledgeEdge {
    readonly fromId: string;
    readonly toRef: string;
    readonly kind: string;
}

export interface V1Knowledge {
    readonly nodes: readonly V1KnowledgeNode[];
    readonly edges: readonly V1KnowledgeEdge[];
}

export interface ImportedKnowledgeEdge {
    readonly toRef: string;
    readonly kind: 'wiki' | 'explicit';
}

export interface ImportedKnowledgeNode {
    readonly id: string;
    readonly title: string;
    readonly body: string;
    readonly class: MemoryClass;
    readonly tags: readonly string[];
    readonly scope: Scope;
    readonly source: Source;
    readonly createdAt: string;
    readonly updatedAt: string;
    readonly edges: readonly ImportedKnowledgeEdge[];
}

export interface V1KnowledgePlan {
    readonly nodes: readonly ImportedKnowledgeNode[];
    /** Everything mapped to the nearest thing or dropped, with why — shown, never swallowed. */
    readonly notes: readonly string[];
}

const MEMORY_CLASSES: readonly string[] = ['profile', 'episodic', 'procedural', 'knowledge'];

function v1Scope(id: string, kind: string, ref: string | null, notes: string[]): Scope {
    if (kind === 'system') return { kind: 'system' };
    if (kind === 'workspace' || kind === 'gapp') {
        if (!ref) { notes.push(`node ${id}: ${kind} scope without a ${kind} id; imported as this machine's`); return { kind: 'system' }; }
        if (kind === 'workspace' && ref === V1_SYSTEM_WORKSPACE) return { kind: 'system' };
        return { kind, id: ref };
    }
    notes.push(`node ${id}: scope "${kind}" is not one Genie 2 has; imported as this machine's`);
    return { kind: 'system' };
}

function v1Tags(id: string, text: string, notes: string[]): string[] {
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { parsed = undefined; }
    if (!Array.isArray(parsed)) { notes.push(`node ${id}: tags were not readable (${JSON.stringify(text.slice(0, 40))}); imported without tags`); return []; }
    return parsed.filter((t): t is string => typeof t === 'string' && t.length > 0);
}

function v1Time(ms: number, fallback: number): string {
    return new Date(Number.isFinite(ms) ? ms : fallback).toISOString();
}

export function planV1KnowledgeImport(v1: V1Knowledge | null): V1KnowledgePlan | null {
    if (v1 === null) return null;
    const notes: string[] = [];
    const ids = new Set(v1.nodes.filter((n) => typeof n.id === 'string' && n.id).map((n) => n.id));
    const edgesOf = new Map<string, ImportedKnowledgeEdge[]>();
    for (const e of v1.edges) {
        if (!ids.has(e.fromId)) { notes.push(`edge ${e.fromId} → ${e.toRef}: its node was not imported`); continue; }
        if (e.kind !== 'wiki' && e.kind !== 'explicit') { notes.push(`edge ${e.fromId} → ${e.toRef}: kind "${e.kind}" is not one Genie 2 has (wiki, explicit)`); continue; }
        const list = edgesOf.get(e.fromId) ?? [];
        list.push({ toRef: e.toRef, kind: e.kind });
        edgesOf.set(e.fromId, list);
    }
    const nodes: ImportedKnowledgeNode[] = [];
    for (const n of v1.nodes) {
        if (typeof n.id !== 'string' || !n.id) { notes.push(`a node without an id (title ${JSON.stringify(String(n.title ?? '').slice(0, 40))}) was not imported`); continue; }
        let cls: MemoryClass = 'knowledge';
        if (MEMORY_CLASSES.includes(n.class)) cls = n.class as MemoryClass;
        else notes.push(`node ${n.id}: class "${n.class}" is not one of Genie 2's four; imported as knowledge`);
        let source: Source = 'agent';
        if (n.source === 'agent' || n.source === 'user') source = n.source;
        else notes.push(`node ${n.id}: source "${n.source}" is neither agent nor user; imported as agent`);
        const createdAt = v1Time(n.createdAt, n.updatedAt);
        nodes.push({
            id: n.id,
            title: n.title,
            body: n.body,
            class: cls,
            tags: v1Tags(n.id, n.tags, notes),
            scope: v1Scope(n.id, n.scopeKind, n.scopeRef, notes),
            source,
            createdAt,
            updatedAt: Number.isFinite(n.updatedAt) ? v1Time(n.updatedAt, n.createdAt) : createdAt,
            edges: edgesOf.get(n.id) ?? [],
        });
    }
    return { nodes, notes };
}
