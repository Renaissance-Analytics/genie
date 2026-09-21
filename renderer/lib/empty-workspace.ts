import type { AgentGridRow } from './ams-grid';

/**
 * WHAT AN EMPTY FLOOR SHOULD SAY.
 *
 * It used to offer two buttons — Add Terminal, Add Code — which is the least
 * useful thing it could say to either audience. To someone who has never set a
 * workspace up, "Add Terminal" is a verb without a reason. To someone whose
 * agents are already running, it is an offer to make a fourth thing while three
 * existing ones sit invisible behind it.
 *
 * So the floor answers the question the person is actually asking, which depends
 * on whether this workspace has agents at all:
 *
 *   - **none** → tell them how to start. An empty workspace is a setup state,
 *     not an error, and it is the one moment where guidance is worth the space.
 *   - **some** → show them, with a live preview of the ones that are running.
 *     Their work is not gone; it is just not on the floor, and a picture of it
 *     says that better than a sentence would.
 *
 * PURE, so the choice is testable without rendering anything — and so the two
 * states cannot drift apart from whatever the component happens to do.
 */

export type EmptyWorkspaceView =
    | { kind: 'getting-started' }
    | { kind: 'agents'; rows: AgentGridRow[] };

/**
 * Decide from the workspace's agent rows.
 *
 * ORPHAN rows are excluded deliberately: an orphan is a leftover terminal spec
 * that no agent owns, so a grid of them would answer "what is in this
 * workspace" with something nobody put there. A workspace whose only rows are
 * orphans is, for this purpose, a workspace with no agents — and the person
 * needs the guide, not a gallery of debris.
 */
export function emptyWorkspaceView(rows: readonly AgentGridRow[]): EmptyWorkspaceView {
    const agents = rows.filter((r) => r.kind === 'agent');
    if (agents.length === 0) return { kind: 'getting-started' };
    return { kind: 'agents', rows: agents };
}

/**
 * Should this row show a live terminal preview?
 *
 * Only a RUNNING agent with a terminal to show. A dormant agent gets its card
 * and nothing else: a preview frame around a dead pty is worse than no frame,
 * because it implies something is happening in there.
 */
export function showsPreview(row: AgentGridRow): boolean {
    return row.kind === 'agent' && row.running && typeof row.specId === 'string' && row.specId.length > 0;
}

/**
 * The logical width a preview renders at, in CSS px, BEFORE FauxClient scales it
 * down to the card.
 *
 * This number is the whole safety argument for previewing a live terminal at
 * all, so it is here rather than inline in the JSX.
 *
 * A terminal measured inside a small frame is the bug behind genie#229: a TUI
 * told it has almost no columns REFLOWS ITS SCROLLBACK to that width, and the
 * damage is already written by the time the panel comes back — first characters
 * clipped, tails spilling down a sliver on the right. The preview must never be
 * able to do that.
 *
 * Two things keep it from happening, and both are required:
 *
 *   1. the preview mounts with `onScreen={false}`, and `shouldFit` refuses
 *      outright on that whatever the container measures — so no fit is ever
 *      pushed to the pty from here;
 *   2. the content lays out at THIS width and is scaled visually, so even if a
 *      fit did run it would measure a full-size terminal rather than a card.
 *
 * Belt and braces on purpose: rule 1 is the guarantee, rule 2 means a future
 * caller who forgets it still cannot produce the reflow.
 */
export const PREVIEW_LOGICAL_WIDTH = 1100;
