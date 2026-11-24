/**
 * A VERSION'S KIND AND COLOUR (Tynn #933, PM G-0; workspace-ux 0.13.0, Tynn PM-3).
 *
 * Since 0.13.0 every version row on the board, WIP and the hotfix lane carries `release_kind` (a normal release or a
 * hotfix) and `colour`, Tynn's effective colour TOKEN for it. Both lists are the contract's
 * (test/workspace-ux-contract.test.ts holds them to it). A value outside them is not a kind or a token: it is dropped
 * here, so nothing Tynn sends reaches a class name as free text.
 */
export const RELEASE_KINDS = ['normal', 'hotfix'] as const;
export type ReleaseKind = (typeof RELEASE_KINDS)[number];
export const VERSION_COLOURS = ['slate', 'blue', 'teal', 'green', 'amber', 'orange', 'red', 'pink', 'violet'] as const;
export type VersionColour = (typeof VERSION_COLOURS)[number];

/** What Tynn said of a version: its kind, and its colour token when it sent one of the nine. */
export interface ReleaseLook { readonly kind: ReleaseKind; readonly colour: VersionColour | null }

const isRow = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The version row's kind and colour; null when the row names no kind (a Tynn older than 0.13.0, or a kind Genie does not know). */
export function releaseLookOf(row: unknown): ReleaseLook | null {
    if (!isRow(row)) return null;
    const kind = RELEASE_KINDS.find((k) => k === row.release_kind);
    if (kind === undefined) return null;
    return { kind, colour: VERSION_COLOURS.find((c) => c === row.colour) ?? null };
}

/** How the kind is drawn, as tynn.ai's own kind badge is (Releases.jsx KindBadge): a hotfix solid, red without a token of its own. */
export interface ReleaseMark { readonly kind: ReleaseKind; readonly colour: VersionColour; readonly label: string; readonly icon: string; readonly solid: boolean }
export function releaseMarkOf(look: ReleaseLook): ReleaseMark {
    const hotfix = look.kind === 'hotfix';
    return { kind: look.kind, colour: look.colour ?? (hotfix ? 'red' : 'slate'), label: hotfix ? 'Hotfix' : 'Release', icon: hotfix ? 'flame' : 'rocket', solid: hotfix };
}
