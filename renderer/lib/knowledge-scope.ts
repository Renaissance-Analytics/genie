import type { KnowledgeScope, WorkspaceRow } from './genie';

/**
 * PURE. How a memory's SCOPE reads, and how the editor's one picker round-trips
 * it.
 *
 * Split out of `pages/knowledge.tsx` so it can be tested without a window: these
 * are the two places the window can silently misreport where a memory lives, and
 * both are string handling rather than rendering.
 *
 * The picker is deliberately FLAT — one control whose value is `system` or
 * `<kind>:<ref>` — rather than a kind selector plus a ref selector. Two controls
 * invent a state (`kind: workspace` with no ref) that cannot be saved, and "which
 * scope" and "which workspace" are one decision to the person making it.
 */

/**
 * How a scope reads to a human.
 *
 * A workspace ref is shown by NAME when the workspace is known — an id in the UI
 * is a lookup the reader has to do by hand. An UNKNOWN one falls back to the id
 * rather than to "workstation": a workspace removed from Genie still has memories
 * scoped to it, and quietly relabelling them would misreport where they live.
 */
export function knowledgeScopeLabel(scope: KnowledgeScope, workspaces: WorkspaceRow[]): string {
    if (scope.kind === 'system') return 'workstation';
    if (scope.kind === 'gapp') return `app · ${scope.appId}`;
    const ws = workspaces.find((w) => w.id === scope.workspaceId);
    return ws ? ws.project_name : `workspace · ${scope.workspaceId}`;
}

/** A scope as the editor's single picker value. */
export function scopePickerValue(scope: KnowledgeScope): string {
    if (scope.kind === 'workspace') return `workspace:${scope.workspaceId}`;
    if (scope.kind === 'gapp') return `gapp:${scope.appId}`;
    return 'system';
}

/**
 * A picker value back into a scope.
 *
 * Split on the FIRST colon only — a ref may contain one, and truncating it would
 * silently file the memory under a different scope. Anything unparseable reads as
 * `system`: the WIDE end of the ladder, so a value we cannot interpret leaves the
 * memory visible rather than hiding it somewhere nobody looks.
 */
export function parseKnowledgeScopeValue(value: string): KnowledgeScope {
    const at = String(value ?? '').indexOf(':');
    if (at < 0) return { kind: 'system' };
    const kind = value.slice(0, at);
    const ref = value.slice(at + 1);
    if (!ref) return { kind: 'system' };
    if (kind === 'workspace') return { kind, workspaceId: ref };
    if (kind === 'gapp') return { kind, appId: ref };
    return { kind: 'system' };
}
