/**
 * A workspace's default avatar: its INITIALS.
 *
 * Every `.agi` workspace rendered the same generic cube, so a rail of six
 * workspaces was six identical glyphs. An icon that tells you nothing is worse
 * than no icon at all, because it occupies exactly the space where the
 * identifying mark belongs. Initials come from the name the user chose, so they
 * differ by construction.
 *
 * A user-set icon overrides this — the field exists on the workspace, and Tynn
 * will set it too. These are only the default.
 *
 * PURE, so the "two workspaces must not collide" cases are testable.
 */

/** Word separators: spaces, dots, hyphens, underscores, slashes. `tynn.ai` is
 *  two words, or it would share a mark with every other `tynn.*`. */
const SPLIT = /[\s._\-/\\]+/;

export function workspaceInitials(name: string): string {
    const words = (name ?? '')
        .split(SPLIT)
        .map((word) => word.replace(/[^\p{L}\p{N}]/gu, ''))
        .filter(Boolean);

    if (words.length === 0) return '?';
    if (words.length === 1) {
        // Two letters of the single word, not one: a single initial collides far
        // too easily across a rail of workspaces.
        return words[0]!.slice(0, 2).toUpperCase();
    }
    return (words[0]!.slice(0, 1) + words[1]!.slice(0, 1)).toUpperCase();
}
