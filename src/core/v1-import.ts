import { isAcpProvider, type AcpProvider } from './engine.js';

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
