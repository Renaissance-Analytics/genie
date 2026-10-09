import { basename, computeDiff } from '@particle-academy/fancy-file-commons';
import type { AgentSession } from '../../main/agentsession/model';
import { inspectorFor } from './tool-inspector';
import { workspaceChanges } from './workspace-changes';
import { sessionFileChanges } from './workspace-file-panel';

/**
 * THE CHANGES TAB — §5.3's Changed filter, scoped to one agent.
 *
 * The board's requirement: the filter *"groups files by who changed them, you included"*. So
 * this projection is about ATTRIBUTION first and volume second. Every changed file sits under
 * the agent that claimed it; the open agent's group leads, because the tab is its own; and a
 * change nobody claimed sits under NOBODY rather than under whichever agent happens to be on
 * screen.
 *
 * ## Built on what already exists
 *
 * Three modules already answer most of this and are reused rather than re-derived:
 *
 *  - `workspace-changes.ts` says WHO changed a file and WHEN, from the agents' own tool calls.
 *  - `workspace-file-panel.ts`'s `sessionFileChanges` folds in what the file watcher saw on
 *    disk, which is how an unclaimed write gets into the view at all.
 *  - `tool-inspector.ts` reads ACP's `diff` content variant out of an untrusted result payload.
 *
 * What is NEW here is grouping by author, and the `+N −M` the board draws — which is the one
 * number `workspace-changes.ts` declined to produce, on the grounds that tool calls *"report
 * no line counts"*. That is still true of the call ITSELF. It is not true of its RESULT: when a
 * provider sends a `diff` entry, the before and after text are both there and the counts are a
 * measurement rather than an estimate. So the number appears exactly when that entry does, and
 * is `null` otherwise.
 *
 * ## `null` is "cannot see", and it is most of this file
 *
 * Measured against a real claude session, a `Write` comes back as a doubly-nested TEXT
 * confirmation — *"File created successfully"* — and no captured turn carried a diff. So
 * uncounted is the COMMON case, not an edge, and a `+0 −8` would be on screen for almost every
 * row. A zero says the file changed nothing; a dash reads as zero too. Both are claims this
 * module has no standing to make, so the field is `null` and the row renders nothing there.
 *
 * The same rule governs the collision state, which Genie cannot see from an `AgentSession` at
 * all: `conflicts` is an input, `null` means nobody looked, and `[]` means somebody looked and
 * found none. Those are different sentences and the view keeps them apart.
 *
 * ## What this does NOT claim, named so it is not mistaken for finished
 *
 *  - **Agent-vs-agent contention.** `workspaceChanges` keeps one row per file — the latest
 *    writer — so a file two agents touched appears only under the later one. "atlas also
 *    changed this" is therefore not in the data this is built on, and is not invented here.
 *  - **Per-line presence** (*"atlas is writing lines 23–26"*). A diff gives line ranges only
 *    for a call that has already finished; an in-flight write reports nothing.
 *  - **A net diff against the file's original state.** The counts are CHURN — the sum of what
 *    the agent's edits added and removed — because each diff entry describes one edit, and the
 *    file's state before the first of them is not on the wire.
 */

/**
 * The collision sentence, verbatim from the board.
 *
 * Exported as a constant so the component cannot drift from it and a test can assert the half
 * that matters: *"Nothing is discarded"*. A collision notice that only says there IS a
 * collision leaves a person assuming their work is gone, which is the opposite of what happens.
 */
export const CONFLICT_NOTICE =
    'Your unsaved edit and an agent’s hunk hit the same lines. Nothing is discarded and the agent pauses on the file.';

export interface ChangedFile {
    /** Relative to the workspace root, because the tree beside it is. */
    path: string;
    /** The file's own name — the part a row leads with. */
    name: string;
    /** Its folder, dimmed beside the name. `null` ⇒ the file is at the root; render nothing. */
    dir: string | null;
    at: number;
    /** Lines added across this agent's edits. `null` ⇒ no diff was reported. NEVER a zero. */
    added: number | null;
    /** Lines removed. Same rule. */
    removed: number | null;
    /**
     * Whether the human's unsaved edit collides here. `null` ⇒ Genie was given no conflict
     * list, so it cannot say — which is not the same as "no collision".
     */
    conflicted: boolean | null;
}

export interface ChangeGroup {
    /** A stable React key: `agent:<id>`, or `unattributed`. */
    id: string;
    /** The author's name. `null` ⇒ nobody claimed these; the group header names no one. */
    who: string | null;
    agentId: string | null;
    /** The agent whose tab this is. Its group leads. */
    self: boolean;
    /** Newest change first. */
    files: ChangedFile[];
    /** Summed over the files that carry counts. `null` ⇒ none of them do. */
    added: number | null;
    removed: number | null;
}

export interface AgentChangesView {
    /** Self first, then siblings by recency, then the unattributed group. `[]` ⇒ nothing yet. */
    groups: ChangeGroup[];
    fileCount: number;
    /** The view's totals, over the files that carry counts. `null` ⇒ no file does. */
    added: number | null;
    removed: number | null;
    /** How many files carry no counts — so a header can say the total is PARTIAL. */
    uncounted: number;
    /** `null` ⇒ no conflict list was supplied. `0` ⇒ there were none. */
    conflictCount: number | null;
}

export interface AgentChangesInput {
    /** Every session Genie can see. Passing just the one agent's yields just its group. */
    sessions: AgentSession[];
    /** Whose tab this is. */
    agentId: string;
    /**
     * What the file watcher saw, workspace-relative path → mtime. `{}` ⇒ it saw nothing.
     *
     * These are UNATTRIBUTED by construction, and `sessionFileChanges` will let a later disk
     * mtime override an agent's claim on the same file — deliberately, and this view honours
     * it. A write Genie cannot tie to a tool call is not evidence about who made it.
     */
    observed?: Record<string, number>;
    /** Paths where the human's unsaved edit collides with an agent's hunk. `null` ⇒ unknown. */
    conflicts?: string[] | null;
}

const UNATTRIBUTED = 'unattributed';

/**
 * The sentinel workspace id.
 *
 * `workspaceChanges` scopes by a `string` id and compares it with `!==`, so a dormant agent's
 * `workspaceId: null` cannot be passed to it — and casting would make `null !== null` the
 * filter, which admits every other workspace-less agent in the process. Scoping happens here
 * instead, with null-safe equality, and the already-scoped sessions are relabelled with this
 * so there is ONE code path for both cases rather than a branch only one test would cover.
 */
const SCOPED = '\u0000scoped';

/**
 * Strip the workspace root — the same normalisation `workspace-changes.ts` applies to the rows.
 *
 * Duplicated rather than imported because its copy is file-private and that file belongs to
 * another pass. The duplication is deliberate and has to stay exact: the counts below are
 * looked up BY PATH against those rows, so a normalisation that disagreed by one separator
 * would silently drop every count — a `null` that reads as "the provider sent no diff".
 */
function relativeTo(root: string, path: string): string {
    const normal = (p: string): string => p.replace(/\\/g, '/').replace(/\/+$/, '');
    const r = normal(root);
    const p = normal(path);
    return p.startsWith(`${r}/`) ? p.slice(r.length + 1) : p;
}

interface LineCount {
    added: number;
    removed: number;
}

/**
 * How many lines one diff entry added and removed, via Fancy's own diff engine.
 *
 * `computeDiff` is what `fancy-git-ui`'s `DiffViewer` and `fancy-code` already parse with, so
 * the number in this header and the hunks in any diff pane come from one implementation. A
 * hand-rolled line count would be a second opinion about the same bytes.
 *
 * Counted from the hunk RANGES rather than by tallying `lines` by side: the ranges are the
 * documented statement of what the hunk covers in each document, while `lines` also carries
 * context for rendering.
 */
function countDiff(before: string, after: string): LineCount {
    const diff = computeDiff(before, after, { segment: false });
    let added = 0;
    let removed = 0;
    for (const hunk of diff.hunks) {
        if (hunk.type === 'equal') continue;
        removed += Math.max(0, hunk.beforeRange.end - hunk.beforeRange.start);
        added += Math.max(0, hunk.afterRange.end - hunk.afterRange.start);
    }
    return { added, removed };
}

/** `agentId` + path, because two agents' counts for one file are two different facts. */
function countKey(agentId: string, path: string): string {
    return `${agentId}\u0000${path}`;
}

/**
 * Every line count Genie can derive, keyed by who made it and which file.
 *
 * SUMMED per file, not replaced: four edits to one file are one row, and the row's number is
 * what those four edits did. Only successful calls count — a failed write changed nothing, and
 * it is not a row either (`workspaceChanges` drops it), so counting it would attach a number
 * to a file that is not in the view.
 */
function lineCounts(sessions: AgentSession[]): Map<string, LineCount> {
    const counts = new Map<string, LineCount>();
    for (const session of sessions) {
        for (const call of session.tools) {
            if (call.status !== 'success') continue;
            // The result is an agent's payload; `inspectorFor` is the existing reader and
            // degrades on junk rather than throwing. It returns a diff only when all three of
            // path/oldText/newText arrived — a one-sided diff is not a diff.
            const diff = inspectorFor(call).diff;
            if (!diff) continue;
            // The diff's OWN path, not the call's arguments: it is the authority for the
            // content it carries, and a multi-file tool could report either.
            const path = relativeTo(session.session.cwd, diff.path);
            const delta = countDiff(diff.oldText, diff.newText);
            const existing = counts.get(countKey(session.agentId, path));
            if (existing) {
                existing.added += delta.added;
                existing.removed += delta.removed;
            } else {
                counts.set(countKey(session.agentId, path), { ...delta });
            }
        }
    }
    return counts;
}

/** Sum the counts that exist, or `null` when none do. Never 0 for "nothing was counted". */
function sum(values: (number | null)[]): number | null {
    const known = values.filter((v): v is number => v !== null);
    return known.length === 0 ? null : known.reduce((a, b) => a + b, 0);
}

function splitPath(path: string): { name: string; dir: string | null } {
    const name = basename(path);
    const cut = path.lastIndexOf('/');
    // `null`, not `''` or `'.'`: a file at the root has no folder, and the row shows nothing
    // rather than a stray separator.
    return { name, dir: cut > 0 ? path.slice(0, cut) : null };
}

export function agentChangesView(input: AgentChangesInput): AgentChangesView {
    const own = input.sessions.find((s) => s.agentId === input.agentId) ?? null;
    // An agent Genie holds no session for has nothing to show. Not an error state: a dormant
    // agent that has never run is exactly this, and the empty sentence is the honest answer.
    const workspaceId = own ? own.session.workspaceId : null;
    const scoped = own
        ? input.sessions
              .filter((s) => s.session.workspaceId === workspaceId)
              .map((s) => ({ ...s, session: { ...s.session, workspaceId: SCOPED } }))
        : [];

    const reported = workspaceChanges(scoped, { workspaceId: SCOPED });
    const changes = sessionFileChanges(reported, input.observed ?? {});
    const counts = lineCounts(scoped);
    const conflicts = input.conflicts ?? null;
    const conflictSet = conflicts === null ? null : new Set(conflicts);

    /** Bucketed in arrival order, which `sessionFileChanges` has already sorted newest first. */
    const buckets = new Map<string, { who: string | null; agentId: string | null; files: ChangedFile[] }>();
    for (const change of changes) {
        const key = change.agentId === null ? UNATTRIBUTED : `agent:${change.agentId}`;
        let bucket = buckets.get(key);
        if (!bucket) {
            bucket = { who: change.who, agentId: change.agentId, files: [] };
            buckets.set(key, bucket);
        }
        /**
         * Counts come from the AUTHOR's calls, and only when there is an author.
         *
         * An unattributed row is a write Genie could not tie to a tool call, so there is no
         * diff behind it even if some agent's diff mentions the same path — attaching one
         * would be guessing that the disk change and that call are the same event.
         */
        const count = change.agentId === null ? undefined : counts.get(countKey(change.agentId, change.path));
        bucket.files.push({
            path: change.path,
            ...splitPath(change.path),
            at: change.at,
            added: count?.added ?? null,
            removed: count?.removed ?? null,
            conflicted: conflictSet === null ? null : conflictSet.has(change.path),
        });
    }

    const groups: ChangeGroup[] = [...buckets.entries()].map(([id, bucket]) => ({
        id,
        who: bucket.who,
        agentId: bucket.agentId,
        self: bucket.agentId === input.agentId,
        files: bucket.files,
        added: sum(bucket.files.map((f) => f.added)),
        removed: sum(bucket.files.map((f) => f.removed)),
    }));

    /**
     * SELF FIRST, then siblings by recency, then the unattributed.
     *
     * The tab belongs to one agent, so its group leads whatever anyone else did a second
     * later — a panel that reorders itself out from under the person whose agent it is was the
     * whole reason to sort explicitly rather than take the map's order. The weakest claim
     * (nobody) goes last; it is context, not the answer to "what did this agent change".
     */
    const rank = (g: ChangeGroup): number => (g.self ? 0 : g.agentId === null ? 2 : 1);
    groups.sort((a, b) => {
        if (rank(a) !== rank(b)) return rank(a) - rank(b);
        return (b.files[0]?.at ?? 0) - (a.files[0]?.at ?? 0);
    });

    const files = groups.flatMap((g) => g.files);
    return {
        groups,
        fileCount: files.length,
        added: sum(files.map((f) => f.added)),
        removed: sum(files.map((f) => f.removed)),
        uncounted: files.filter((f) => f.added === null).length,
        conflictCount: conflictSet === null ? null : files.filter((f) => f.conflicted === true).length,
    };
}
