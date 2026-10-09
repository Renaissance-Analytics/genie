import type { AgentSession } from '../../main/agentsession/model';
import type { GitFileStatus, GitStatusMap } from './genie';
import { workspaceChanges } from './workspace-changes';
import { changedFilePaths, sessionFileChanges } from './workspace-file-panel';

/**
 * THE AGENT'S FILES — §5.3's workspace file panel, FILTERED TO ONE AGENT.
 *
 * The board: *"One panel per workspace: tree and editor. Changed files name the agent touching
 * them … The Changed filter groups files by who changed them, you included … The agent's Files
 * and Changes tabs open this panel filtered to that agent."*
 *
 * So this is not a second file panel. It is the same question — what changed here, and who
 * changed it — asked with one agent's name already in the filter slot. The machinery that
 * answers it already exists and is reused rather than reimplemented:
 *
 *  - `workspaceChanges` turns reported tool calls into one row per file with its author. Called
 *    TWICE here, which is the whole trick: once over this agent alone, to get its own latest
 *    touch per file, and once over the workspace, to learn who holds each file NOW.
 *  - `sessionFileChanges` merges the file watcher's unnamed disk events in and **drops the
 *    author** when a disk event is newer than the newest reported write.
 *  - `changedFilePaths` unions all of that with git's own status, which is the only producer
 *    that knows about a file changed before Genie was watching.
 *
 * ## The rule this surface exists to obey
 *
 * *"A file changed on disk that no agent reported is NOT this agent's. It shows in neutral grey
 * with a '?'. Genie does not guess the author."*
 *
 * Attribution is the only thing here that git cannot already tell you, so an attribution this
 * view is not entitled to make would remove its entire reason to exist. Hence: unclaimed
 * changes are COUNTED, never listed under the agent's name; a file another agent wrote more
 * recently keeps its row (the agent really did edit it) but names the later writer; and a file
 * whose newest write is unclaimed is flagged even while it sits in the agent's own list.
 *
 * ## What it refuses to produce
 *
 * No `+42 −8`, and no "writing lines 23–26". `workspace-changes.ts` records why and the reason
 * is unchanged: tool calls report no line counts and no line ranges, so either number would be
 * an estimate rendered in the typeface of a measurement.
 */

export interface AgentFileRow {
    /** Workspace-relative, because the tree beside it is. */
    path: string;
    /** The last segment — the part that differs, and the part a row leads with. */
    name: string;
    /** The folder, or **null** for a file at the workspace root. Not `''` or `'.'`: there is
     *  no folder to draw, and an empty string renders as an empty row. */
    dir: string | null;
    /**
     * When THIS agent last changed it.
     *
     * May be `0`, which `workspaceChanges` produces for a call the provider never stamped.
     * Zero means unstamped, not 1970 — a consumer formats it with something that renders
     * nothing for a falsy stamp rather than printing a date from the epoch.
     */
    at: number;
    /** Git's word for its current state, or null when git said nothing about this path.
     *  Null renders as NOTHING — never a dash, which reads as a state git reported. */
    status: GitFileStatus | null;
    /** The agent that wrote this file AFTER this one did, by name. Null ⇒ nobody did. */
    supersededBy: string | null;
    /**
     * The newest write to this file is one NO AGENT CLAIMED.
     *
     * The row stays — the agent's own edit is still a fact — but it cannot be read as "this
     * agent's current version", because something else has been over it since.
     */
    touchedOnDisk: boolean;
}

/** One other agent's share of the workspace's changed files. A COUNT, so the filter never
 *  hides work silently: a human who cannot see this number cannot tell a quiet workspace
 *  from a tight filter. */
export interface AgentFilesOther {
    who: string;
    agentId: string;
    count: number;
}

export interface AgentFilesView {
    /** This agent's name, so a surface need not re-derive it from the session. */
    who: string;
    /**
     * The agent's changed files, newest first.
     *
     * **null ⇒ cannot be filtered at all** — Genie does not know which workspace this agent is
     * in, so there is no panel to filter and no honest list to show. `[]` ⇒ the agent has
     * changed nothing, which is a fact about a working agent rather than a missing value.
     */
    rows: AgentFileRow[] | null;
    /** Changed files held by OTHER agents, most files first then alphabetical. `[]` ⇒ none. */
    others: AgentFilesOther[];
    /** Changed files no agent reported. Counted and never attributed. */
    unattributed: number;
}

function split(path: string): { name: string; dir: string | null } {
    const cut = path.lastIndexOf('/');
    if (cut < 0) return { name: path, dir: null };
    return { name: path.slice(cut + 1), dir: path.slice(0, cut) };
}

export function agentFilesView(input: {
    session: AgentSession;
    /** Every session Genie holds. Filtered to the workspace here, and this agent's own entry
     *  may or may not be in it — either way it is counted once. */
    sessions: AgentSession[];
    gitStatus: GitStatusMap;
    /** The file watcher's unnamed disk events: workspace-relative path → when it moved. */
    observed: Record<string, number>;
}): AgentFilesView {
    const { session, gitStatus, observed } = input;
    const who = session.session.name;
    const workspaceId = session.session.workspaceId;
    if (workspaceId === null) return { who, rows: null, others: [], unattributed: 0 };

    const mine = workspaceChanges([session], { workspaceId });
    /**
     * The workspace's own answer, with THIS session put in by hand.
     *
     * De-duplicated by agent id rather than trusting the caller to pass a roster that does or
     * does not include the agent being viewed. Both mistakes are silent: omit it and the
     * agent's own files land in `unattributed`; pass it twice and nothing breaks today but the
     * next counting rule written here would double.
     */
    const all = workspaceChanges(
        [session, ...input.sessions.filter((s) => s.agentId !== session.agentId)],
        { workspaceId },
    );

    // Author per path AFTER the watcher has had its say — `who: null` here means the newest
    // write to that path is unclaimed, whoever reported an earlier one.
    const current = new Map(sessionFileChanges(all, observed).map((row) => [row.path, row]));
    const latestReported = new Map(all.map((row) => [row.path, row]));

    const rows: AgentFileRow[] = mine.map((change) => {
        const reported = latestReported.get(change.path);
        return {
            path: change.path,
            ...split(change.path),
            at: change.at,
            // Including `'ignored'`: a file the agent genuinely changed stays on its list even
            // when git is not tracking it. `changedFilePaths` drops ignored paths because an
            // ignored file nobody claimed is not news; a reported write to one is.
            status: gitStatus[change.path] ?? null,
            supersededBy:
                reported && reported.agentId !== session.agentId && reported.at > change.at
                    ? reported.who
                    : null,
            touchedOnDisk: (current.get(change.path)?.who ?? null) === null,
        };
    });

    const minePaths = new Set(mine.map((change) => change.path));
    const others = new Map<string, AgentFilesOther>();
    let unattributed = 0;
    for (const path of changedFilePaths([...current.values()], gitStatus)) {
        if (minePaths.has(path)) continue;
        const holder = current.get(path);
        // No row, or a row the watcher stripped the author from. Either way nobody has claimed
        // it, and the count is as far as this view will go.
        if (!holder || holder.who === null || holder.agentId === null) {
            unattributed += 1;
            continue;
        }
        const existing = others.get(holder.agentId);
        if (existing) existing.count += 1;
        else others.set(holder.agentId, { who: holder.who, agentId: holder.agentId, count: 1 });
    }

    return {
        who,
        rows,
        // Most files first: the question behind this footer is "who else is in here", and the
        // agent with the most files is the most of an answer. Name breaks the tie so the list
        // is stable across renders rather than following map insertion.
        others: [...others.values()].sort((a, b) => b.count - a.count || a.who.localeCompare(b.who)),
        unattributed,
    };
}

export interface AgentFileGroup {
    dir: string | null;
    rows: AgentFileRow[];
}

/**
 * The rows grouped by folder, which is as much tree as this surface can honestly draw.
 *
 * The real panel's tree comes from the filesystem; these rows come from what agents reported,
 * so a folder here exists because a changed file is in it. Grouping is kept pure for the usual
 * reason — the renderer's test environment has no DOM, so a decision made inside a component
 * is a decision nobody checks.
 *
 * **Folder order follows the rows**, first appearance wins. Sorting the folders alphabetically
 * instead would silently discard the newest-first ordering the rows arrived in, and the newest
 * change is the one somebody opened this tab to find.
 */
export function agentFileGroups(rows: AgentFileRow[]): AgentFileGroup[] {
    const groups: AgentFileGroup[] = [];
    const byDir = new Map<string, AgentFileGroup>();
    for (const row of rows) {
        // A real folder can never collide with this key, because `dir` is already split on `/`.
        const key = row.dir ?? '\u0000root';
        const existing = byDir.get(key);
        if (existing) {
            existing.rows.push(row);
            continue;
        }
        const group: AgentFileGroup = { dir: row.dir, rows: [row] };
        byDir.set(key, group);
        groups.push(group);
    }
    return groups;
}
