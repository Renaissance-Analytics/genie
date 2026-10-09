/**
 * What `GENIE_E2E_VIEW` becomes in the harness window's URL.
 *
 * Extracted from `index.ts`, where it was built inline and nothing tested it — which mattered
 * the moment the Workbench became a thing specs needed to ask for.
 *
 * ## The trap this exists to stop
 *
 * `parseViewRoute` accepts `deck | grid | dashboard` for `view`, and NOTHING else. The
 * Workbench is addressed by `?ws=<id>` — it has no `view` name. So `GENIE_E2E_VIEW=workbench`
 * translated the obvious way produces `?view=workbench`, which the route cannot satisfy and
 * silently degrades to the DEFAULT surface.
 *
 * That failure is invisible in the worst way: the window opens, renders a real surface, and
 * every panel assertion in the spec fails with "element not found" — which reads as the panel
 * being broken rather than as the harness having asked for the wrong screen. On three
 * platforms, at roughly twelve minutes a shard.
 */

/** The seeded workspace the master harness builds. Must match `master.ts`'s `WORKSPACE_ID`. */
export const E2E_WORKSPACE_ID = 'e2e-master-window';

/**
 * The query string for a requested view, including the leading `?`, or `''` for none.
 *
 * An unset or blank value yields no query at all, deliberately: the harness then opens
 * whatever the PRODUCT opens, so a default surface that fails to render is caught by a spec
 * rather than hidden behind an override.
 */
export function e2eViewQuery(view: string | undefined, workspaceId = E2E_WORKSPACE_ID): string {
    const wanted = view?.trim();
    if (!wanted) return '';
    // The Workbench is a WORKSPACE, not a named view. Translated here rather than at five call
    // sites, because the one thing worse than this special case is four copies of it.
    if (wanted === 'workbench') return `?ws=${encodeURIComponent(workspaceId)}`;
    return `?view=${encodeURIComponent(wanted)}`;
}
