/**
 * Is this workspace a `.agi` PROJECT envelope? Two questions, kept apart
 * (genie#553).
 *
 * The owner's report: *"the Genie OSA still thinks of itself as an AGI envelope,
 * why would it do that? It keeps trying to create a new repo using the same
 * names."*
 *
 * Envelope-ness was decided entirely by what the DIRECTORY looked like — the
 * row's `shape`, the `detectFolder` state, a `project.json`, a `.gitmodules` —
 * and nothing consulted what the workspace is FOR. The workstation operator's
 * own row is written with `shape: 'agi'` (`ensureSystemWorkspaceRow`) and its
 * `~/.gosa` envelope carries a `project.json`, so the flag was true by
 * construction; a workspace a human then DESIGNATES as the operator
 * (`setWorkstationOperator`) is usually a real envelope folder as well, so it is
 * true twice over.
 *
 * The orientation prose already got this right — it branches on the operator
 * designation first and says "It is not a project" — but the flag underneath
 * stayed true, and `formatWorkspaceMap` echoes the whole map as a
 * machine-parseable JSON block. So the operator read `"workstationOperator":
 * true` and `"isAgiEnvelope": true` in the same object on every
 * `connectToGenie` call. That contradiction cannot be gated at the consumer,
 * because the consumer is a language model rather than a branch: it reads both
 * and believes the one it can act on.
 *
 * Hence two functions instead of one flag doing two jobs.
 *
 * - {@link hasEnvelopeShape} — the FACT about the folder. Unchanged by role,
 *   because the folder is unchanged by role.
 * - {@link isProjectEnvelope} — the CLAIM about the workspace, which is what
 *   every reader of the old flag was actually asking. False for an operator
 *   whatever its folder looks like.
 *
 * Nothing is lost by the narrowing: the workspace map carries `hasProjectJson`,
 * `hasGitmodules` and the `repos` list in their own fields, so a reader that
 * genuinely wants the directory's shape still has it — and the operator keeps
 * the repo listing that makes its own folder navigable.
 */

/** The directory facts envelope-ness used to be read from, gathered in one place. */
export interface EnvelopeShapeFacts {
    /** The workspace row's recorded shape (`'agi'` for an envelope). */
    shape?: string | null;
    /** `detectFolder(root).state`, or null when the folder could not be read. */
    detectedState?: string | null;
    /** A `project.json` at the workspace root. */
    hasProjectJson: boolean;
    /** A `.gitmodules` at the workspace root. */
    hasGitmodules: boolean;
}

/** PURE. Does this folder LOOK like a `.agi` envelope? Any one signal is enough. */
export function hasEnvelopeShape(facts: EnvelopeShapeFacts): boolean {
    return (
        facts.shape === 'agi' ||
        facts.detectedState === 'FULL_ENVELOPE' ||
        facts.hasProjectJson ||
        facts.hasGitmodules
    );
}

/**
 * PURE. Is this workspace a `.agi` project envelope — a place whose repos are
 * the work?
 *
 * The workstation operator is not, in any folder. Its job is the machine, and a
 * workspace that is not a project cannot have project repos as its primary
 * resource no matter what is on disk beside it.
 */
export function isProjectEnvelope(
    facts: EnvelopeShapeFacts & { workstationOperator: boolean },
): boolean {
    if (facts.workstationOperator) return false;
    return hasEnvelopeShape(facts);
}
