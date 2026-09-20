import { awakeSpecs } from './workspace-hibernation';

/**
 * A SLEEPING WORKSPACE HAS NO PANELS (genie#723).
 *
 * The owner's contract, given when asked: *"the panels should close when a
 * workspace hibernates. NOTHING should be running from a hibernated
 * workspace."*
 *
 * Hibernation (#672) already stops the ptys. What it never did was take the
 * PANELS down, so a sleeping workspace's terminals kept appearing — and once
 * #705 hid hibernated workspaces from the rail, they appeared under
 * **Unattached**, because the grouping buckets specs by the workspaces it can
 * see and anything else falls through to "orphaned". Two features, each correct
 * alone, producing a list of panels belonging to a workspace the UI had just
 * been told to hide.
 *
 * REMOVING A PANEL IS NOT DELETING A SPEC. The rows stay in the database
 * untouched — waking has to bring the workspace back with its terminals, and a
 * wake that restored an empty workspace would be worse than the bug. This is a
 * view filter and nothing else.
 *
 * Only a workspace KNOWN to be hibernating takes its panels down:
 *   - `workspace_id: null` is genuinely unattached and is left alone;
 *   - a spec naming a workspace not in the list is left alone too, because
 *     "I have never heard of this workspace" is not the same as "that workspace
 *     is asleep", and treating absence as sleep would silently swallow panels
 *     whenever the caller passes a filtered list.
 *
 * Pure, so the rule is testable without a window — and so the same predicate can
 * be reused by anything else that lists panels.
 */

/** The fields this rule needs from a workspace. */
export interface HibernationWorkspace {
    id: string;
    hibernated_at?: number | null;
}

/** The fields this rule needs from a panel spec. */
export interface PanelSpecLike {
    workspace_id?: string | null;
}


/**
 * The panels that should be on screen: everything except those belonging to a
 * workspace that is currently hibernating.
 *
 * DELEGATES to `awakeSpecs` rather than restating the rule. That function
 * already decides this for the floor and is already applied to both the active
 * and the background panel sets — "is this workspace asleep" must not have two
 * implementations that can drift. This is the list-shaped door onto it, for
 * callers holding an array of workspaces instead of the map.
 */
export function withoutHibernatedPanelSpecs<T extends PanelSpecLike>(
    specs: readonly T[],
    workspaces: readonly HibernationWorkspace[],
): T[] {
    return awakeSpecs(
        specs as readonly (T & { workspace_id?: string | null })[],
        new Map(workspaces.map((w) => [w.id, w])),
    );
}


/**
 * Does this spec belong to a workspace that EXISTS but is not being displayed?
 *
 * The other half of #723, and the one that will otherwise come back. `Chooser`
 * buckets specs by the DISPLAYED workspace list and calls anything without a
 * bucket "orphaned" — so hiding a workspace row, for any reason, reclassified
 * its terminals as leftovers nothing owns. The System Workspace already carried
 * a hand-written exemption for exactly this ("they are NEVER orphaned, so they
 * don't leak into the Unattached group when the System Workspace is hidden");
 * hibernation then became the second way in, and the next hidden-row feature
 * would be the third.
 *
 * So: ORPHANED must mean *no workspace owns this*, never *its workspace is
 * hidden right now*.
 */
export function ownedByHiddenWorkspace(
    spec: PanelSpecLike,
    knownWorkspaceIds: ReadonlySet<string>,
    displayedWorkspaceIds: ReadonlySet<string>,
): boolean {
    const id = spec.workspace_id;
    if (!id) return false; // genuinely unattached
    return knownWorkspaceIds.has(id) && !displayedWorkspaceIds.has(id);
}
