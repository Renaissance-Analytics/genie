/**
 * THE shared-schemas RELEASE THIS GENIE'S SAVE WRITES AGAINST (Tynn #756). A tag, never a branch: tags are immutable
 * (shared-schemas AGENTS.md), so what a file was validated against cannot change under it.
 */
export const SHARED_SCHEMAS_PIN = {
    repo: 'Civicognita/shared-schemas',
    tag: 'v0.5.0',
    /** The commit the tag points at (verified against the repo 2026-11-16). */
    commit: '2cbd6b8aa01c084be376bf3900d72e6640dbe667',
    revision: '0.5.0',
} as const;
