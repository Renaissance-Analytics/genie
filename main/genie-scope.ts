/**
 * WHOSE REASONING a thing belongs in — `system | workspace | gapp`.
 *
 * A leaf module with no imports, for the same reason
 * `workspace/system-workspace-id.ts` is one: the knowledge store, the MCP
 * surface and the flow store all need the same ladder, and two definitions of it
 * would be two answers to the same question. Flows shipped `FlowScope` with this
 * exact shape; see the note on {@link GenieScope} for what keeps them one ladder
 * rather than two that agree today.
 *
 * ★ SCOPE IS NOISE REDUCTION IN AGENT REASONING. IT IS NOT A SECURITY BOUNDARY.
 * Any caller may ask for every scope and be served. Scope exists so an agent's
 * context is not polluted by knowledge it has no business acting on — nothing
 * more. Do not document it as a security control, and do not build anything
 * security-bearing on top of it. Anything that must actually be WITHHELD from an
 * agent does not belong in a store that scope filters.
 *
 * Deliberately asymmetric to a knowledge node's memory `class`, which IS refused
 * when unknown: a wrong class silently answers the wrong question, whereas a wide
 * scope merely returns more than you wanted.
 *
 * The words are the owner's and they match what the code already calls things:
 * the System Workspace row id is literally `'__system__'`, and `gapp` is the word
 * in `gapp.json`, `manageGappDev` and the GApp Store.
 */

export type GenieScopeKind = 'system' | 'workspace' | 'gapp';

export const GENIE_SCOPE_KINDS: readonly GenieScopeKind[] = ['system', 'workspace', 'gapp'];

/** The scope kind a thing gets when nothing says otherwise — and what everything
 *  written before scope existed is. `system` is the WIDE end of the ladder: a
 *  backfilled row stays visible exactly as it was, and showing too much is
 *  recoverable in a way that silently hiding knowledge is not. */
export const DEFAULT_GENIE_SCOPE_KIND: GenieScopeKind = 'system';

/**
 * A scope. `system` has no ref (it is the whole workstation); `workspace` and
 * `gapp` name the one workspace or app they belong to.
 *
 * ★ STRUCTURALLY IDENTICAL TO `FlowScope` (`flows/types.ts`), deliberately, down
 * to the field names — `workspaceId` and `appId` rather than one shared `ref`.
 * Two ladders that mean the same thing and spell it differently is the drift §11
 * of the knowledge-graph spec exists to prevent, and a shared `ref` would have
 * been exactly that: assignable in neither direction, so nothing would ever
 * notice them diverging. `genie-scope.test.ts` asserts the two are mutually
 * assignable, which fails the moment either side changes alone.
 *
 * This module rather than `flows/types.ts` is where the definition lives because
 * this one is a LEAF — no imports at all — so `db.ts`, the knowledge store and
 * the MCP surface can each take it without pulling the Flows runtime in behind
 * it. Flows can adopt it whenever it suits; until it does, the test is the joint.
 */
export type GenieScope =
    | { kind: 'system' }
    | { kind: 'workspace'; workspaceId: string }
    | { kind: 'gapp'; appId: string };

export function isGenieScopeKind(v: unknown): v is GenieScopeKind {
    return typeof v === 'string' && (GENIE_SCOPE_KINDS as readonly string[]).includes(v);
}

/**
 * Read a stored `(kind, ref)` pair back as a scope.
 *
 * An unrecognised kind — a newer Genie's, a hand edit — and a `workspace`/`gapp`
 * row with no ref both read as `system`. That is the same fallback direction the
 * memory class takes on read: the value stays VISIBLE rather than resolving to a
 * scope nobody can see it from.
 */
export function parseGenieScope(kind: unknown, ref: unknown): GenieScope {
    if (!isGenieScopeKind(kind) || kind === 'system') return { kind: 'system' };
    const r = typeof ref === 'string' ? ref.trim() : '';
    if (!r) return { kind: 'system' };
    return kind === 'workspace' ? { kind, workspaceId: r } : { kind, appId: r };
}

/**
 * The `scope_ref` column value for a scope — null for `system`.
 *
 * The storage column is one `scope_ref` while the TYPE names its two refs
 * separately, and that asymmetry is on purpose: the type is read by people and
 * type-checkers, where `workspaceId` says what it is, and the column is read by
 * an index, where `(scope_kind, scope_ref)` is one key rather than two mostly
 * empty ones.
 */
export function scopeRefOf(scope: GenieScope): string | null {
    if (scope.kind === 'workspace') return scope.workspaceId;
    if (scope.kind === 'gapp') return scope.appId;
    return null;
}
