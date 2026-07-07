/**
 * New-workspace ENTRY detection — shared by the sidebar RAIL buttons and the
 * flyout MENU rows so a genuinely-new workspace fades/slides into BOTH the same
 * way, instead of popping in.
 *
 * Why this exists: when a workspace is auto-provisioned onto a workstation and
 * pushed to a REMOTE Genie session over the host bridge, the host-sourced
 * `workspaces` list live-updates. Diffing that list by id tells us which id JUST
 * arrived, so we can one-shot an entry animation on ONLY that row — never
 * re-animating existing rows on a re-render/reorder/rename.
 *
 * Kept free of React/DOM so it unit-tests under Node; Chooser maps the result
 * onto a transient `ws-enter` CSS class (dropped after the animation, like the
 * `pulsing` one-shot). Mirrors `workstation-status.ts`'s connectable diff.
 */

/**
 * The workspace ids eligible to animate on entry — every id in the list except
 * the synthetic System Workspace (`excludeId`). That row is a client-local
 * sidebar toggle (never provisioned / remote-sourced), so revealing it must NOT
 * trigger an entry animation.
 */
export function enterableWorkspaceIds(
    workspaces: ReadonlyArray<{ id: string }>,
    excludeId: string,
): Set<string> {
    const ids = new Set<string>();
    for (const ws of workspaces) if (ws.id !== excludeId) ids.add(ws.id);
    return ids;
}

/**
 * The ids that JUST appeared — present in `current`, absent from the
 * previously-observed `prev` set. `prev === null` (the first observation, no
 * baseline yet) returns [] so the INITIAL workspace list never animates; only a
 * genuine later arrival does. A re-render / reorder / rename keeps the id set
 * stable, so nothing re-fires — the diff keys on id membership only.
 */
export function newlyAddedWorkspaceIds(
    prev: ReadonlySet<string> | null,
    current: ReadonlySet<string>,
): string[] {
    if (prev === null) return [];
    return [...current].filter((id) => !prev.has(id));
}
