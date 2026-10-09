import type { LineRange } from '@particle-academy/fancy-file-commons';
import type { GitFileStatus, GitStatusMap } from './genie';
import {
    diskWriteMarks,
    type ConflictPauses,
    type ConflictScan,
    type FileConflict,
    type LockProbe,
    type OpenTab,
} from './file-panel-states';
import type { SessionFileChange } from './workspace-file-panel';

/**
 * WHERE §5.3's PANEL STATES GET THEIR INPUTS.
 *
 * `file-panel-states.ts` decided the rules and named, in its own header, the inputs it could
 * not source: *"Nothing in Genie reports a git lock … {@link repoLockState} therefore consumes
 * OBSERVATIONS of the lock file"*. This module is those observations, plus the two other joins
 * `CodePanel` needs to call the rules at all: the panel's tab map turned into the three texts a
 * collision is decided from, and the rules' output turned into rows a surface can draw.
 *
 * Everything here is pure. The panel's effects do the IPC and hand the answers in — so the
 * DECISIONS are testable even though the renderer has no DOM, which is the same split
 * `editor-open.ts` and `agent-files-view.ts` already use.
 *
 * ## The hazard this module exists to contain
 *
 * `files.exist` answers with the paths it FOUND (`main/files/ipc.ts`'s `existingFiles`), and it
 * catches every failure per path — *"missing, unreadable, or not a usable path"* all return
 * false and get filtered out. So absence and blindness arrive as the same silence. Handing that
 * silence to `repoLockState` as `present: false` would manufacture a measurement: `false` there
 * means *looked, nothing there*, and the chip would report a clean repo it never managed to
 * read. Hence {@link LOCK_PROBE_PATHS} asks for THREE paths, two of which exist only to tell
 * the silences apart.
 */

/** Git's own lock, and the path {@link repoLockState} prints in its fix. */
const INDEX_LOCK = '.git/index.lock';
/**
 * The POSITIVE CONTROL for the probe's own eyesight.
 *
 * `existingFiles` returns FILES only — a directory is filtered out (measured: its own test
 * asserts `existingFiles(ws, ['main', 'main/db.ts'])` returns just the file). So in a normal
 * repo `.git` never comes back and `.git/HEAD` does, and `.git/HEAD` coming back is the one
 * piece of evidence that proves the call could read INSIDE `.git` — which is what makes a
 * missing `index.lock` an absence rather than a failure.
 */
const GIT_HEAD = '.git/HEAD';
/**
 * `.git` itself, which comes back ONLY when it is a file — a worktree or a submodule. The real
 * git dir is then outside the workspace root, where `guardedResolve` will not follow, so there
 * is nothing at this path to find and no way to say there is nothing. Measured on this very
 * checkout, which is a worktree: its `.git` is a 75-byte file.
 */
const GIT_FILE = '.git';

/** What one lock observation asks `files.exist` for. */
export const LOCK_PROBE_PATHS: readonly string[] = [GIT_FILE, GIT_HEAD, INDEX_LOCK];

/**
 * How many observations to keep.
 *
 * The bound is load-bearing, not housekeeping: `repoLockState` measures the hold from the
 * OLDEST RETAINED sighting, so a run too short to span its stale window can never reach
 * `stale` — a lock stuck for an hour would report `held` forever and the chip would go quiet
 * exactly when it has something to say. Eight observations at {@link LOCK_PROBE_MS} span 35s
 * against a 10s window. The margin is asserted by test rather than by this comment.
 */
export const PROBE_KEEP = 8;

/**
 * How often to look again while a lock is actually present.
 *
 * Genie prefers pushed events to polling, and this is the exception that earns itself: a stuck
 * lock means git is stuck, so NOTHING else happens — no write, no watcher event, no git status
 * — and a purely event-driven probe would never take the second look that distinguishes a lock
 * held for milliseconds from one held forever. The panel therefore polls only while it can
 * see a lock, and rides the file watcher otherwise.
 */
export const LOCK_PROBE_MS = 5_000;

/**
 * Read one `files.exist` answer as an observation.
 *
 * Three outcomes, and the two `null`s are different silences with the same honest answer:
 *
 *  - `.git` came back ⇒ it is a FILE ⇒ worktree or submodule ⇒ **blind**. Checked FIRST, so a
 *    half-populated answer in a worktree can never read as a clean repo.
 *  - `.git/HEAD` did not come back ⇒ the call could not read inside a git dir (not a repo, a
 *    refused path, an unreadable one) ⇒ **blind**.
 *  - otherwise the call could see inside, so the lock's presence is a MEASUREMENT.
 */
export function lockProbe(found: readonly string[], at: number): LockProbe {
    if (found.includes(GIT_FILE)) return { at, present: null };
    if (!found.includes(GIT_HEAD)) return { at, present: null };
    return { at, present: found.includes(INDEX_LOCK) };
}

/**
 * Append an observation to the run, keeping the newest {@link PROBE_KEEP}.
 *
 * Order is preserved rather than re-sorted — `repoLockState` sorts by `at` itself, and doing it
 * twice would be two opinions about one clock.
 */
export function recordProbe(probes: LockProbe[], probe: LockProbe, keep = PROBE_KEEP): LockProbe[] {
    const next = [...probes, probe];
    return next.length > keep ? next.slice(next.length - keep) : next;
}

/** One of `CodePanel`'s open tabs, as the panel already holds it. */
export interface PanelTab {
    path: string;
    /** The live buffer. A plugin tab has none here — its model lives in the plugin. */
    content: string;
    /** What the editor loaded or last saved. Absent on a plugin tab, and on a text tab that
     *  never got one — either way there is no common ancestor to diff against. */
    baseline?: string;
    /** The panel's own flag. Used for the OPAQUE count rather than comparing texts, because a
     *  plugin tab has no texts to compare and its dirty flag is the only thing that knows. */
    dirty: boolean;
    kind?: 'text' | 'plugin';
}

/**
 * The panel's tabs as {@link OpenTab}s, and a COUNT of the ones it cannot compare.
 *
 * Two kinds of blindness, kept apart because they are blind at different ends:
 *
 *  - **opaque** — a DIRTY tab whose own BUFFER Genie cannot read: a plugin tab (the model is
 *    inside the plugin) or a tab with no baseline (no common ancestor). Counted here, because
 *    such a tab never reaches `scanConflicts` at all and would otherwise vanish from the
 *    accounting entirely — the silent all-clear this whole area exists to prevent.
 *  - **unreadable** — a dirty tab whose DISK text is missing. Not counted here: it is passed
 *    through as `disk: null` so `ConflictScan.unreadable` counts it, by the rule that already
 *    exists. A path absent from `disk` is treated the same as one that failed — "we have not
 *    got the text" is the fact, and which silence it was does not change the answer.
 *
 * CLEAN tabs are passed through untouched and never counted. `scanConflicts` discards them
 * itself (`buffer === baseline` ⇒ the panel reloads it, nothing to lose), and a clean plugin
 * tab is not a gap for the same reason: there is nothing at risk in one.
 */
export function openTabsForScan(
    tabs: PanelTab[],
    disk: ReadonlyMap<string, string | null>,
): { tabs: OpenTab[]; opaque: number } {
    const readable: OpenTab[] = [];
    let opaque = 0;
    for (const tab of tabs) {
        if (tab.kind === 'plugin' || typeof tab.baseline !== 'string') {
            if (tab.dirty) opaque += 1;
            continue;
        }
        readable.push({
            path: tab.path,
            baseline: tab.baseline,
            buffer: tab.content,
            // `?? null` and not `|| null`: an EMPTY file is a text we have, and `''` is the
            // right answer for it.
            disk: disk.get(tab.path) ?? null,
        });
    }
    return { tabs: readable, opaque };
}

/**
 * Where a collision is, in the numbers a human reads.
 *
 * `FileConflict.lines` is 0-based and half-open because that is what a diff produces. A gutter
 * starts at 1, so a notice printed in diff coordinates points one line above the collision. A
 * SEAM (`start === end`) is a position rather than a span, and `lines 6–6` would name a line
 * neither side wrote.
 */
export function conflictLines(lines: LineRange[]): string {
    return lines
        .map((range) => {
            if (range.start === range.end) return `before line ${range.start + 1}`;
            if (range.end - range.start === 1) return `line ${range.start + 1}`;
            return `lines ${range.start + 1}–${range.end}`;
        })
        .join(', ');
}

/**
 * WHAT GENIE HAS DONE ABOUT THE OTHER SIDE of a collision.
 *
 * The banner's second sentence is a claim about an agent's state, so it gets a state of its
 * own rather than being inferred at the point of render:
 *
 *  - `asking` — `cancel` has been sent and not yet honoured. A request, not a result.
 *  - `paused` — it came back honoured. The ONLY state that may say the agent stopped.
 *  - `unreachable` — no live terminal to ask through, so nothing was even sent.
 *  - `unclaimed` — nobody reported the write, so there is nobody to ask.
 */
export type PauseState = 'asking' | 'paused' | 'unreachable' | 'unclaimed';

/**
 * The banner's title — *"atlas changed lines 13–16 while you had unsaved edits to line 13"*.
 *
 * Both ranges, because they are two different measurements: `theirLines` is the writer's
 * colliding hunk and `lines` is the human's own edit, and one printed for both would tell the
 * user the agent touched exactly the lines they did.
 */
export function conflictTitle(conflict: FileConflict): string {
    const mine = `while you had unsaved edits to ${conflictLines(conflict.lines)}`;
    const theirs = conflictLines(conflict.theirLines);
    return conflict.who === null
        ? `A write no agent reported changed ${theirs} ${mine}`
        : `${conflict.who} changed ${theirs} ${mine}`;
}

/**
 * The banner's body.
 *
 * The first sentence is true in every state and is the whole point of the notice: `CodePanel`
 * refuses to reload a dirty tab, so the buffer really is safe, and a notice that reported only
 * the collision would read as data loss.
 *
 * The second is a claim about the AGENT, and it is made strictly from {@link PauseState}. An
 * agent still running while the banner says it stopped is the one failure here that costs
 * somebody their code, so `paused` is the only state that says so.
 */
export function conflictBody(conflict: FileConflict, pause: PauseState): string {
    const safe = 'Your version is kept as a draft and nothing is lost.';
    const who = conflict.who ?? 'the writer';
    switch (pause) {
        case 'paused':
            return `${safe} ${who} has been told the file is in conflict and is paused on it.`;
        case 'asking':
            return `${safe} Genie is asking ${who} to stop.`;
        case 'unreachable':
            return `${safe} Genie cannot reach ${who} — stop it yourself.`;
        case 'unclaimed':
            return `${safe} No agent reported the write, so there is nobody to pause.`;
    }
}

/**
 * Which pause state a conflict is in, from what `conflictPauses` could actually ask.
 *
 * `honoured` is the set of paths whose `cancel` came back honoured, and it is read ONLY for a
 * conflict that had a request to send. No request ⇒ `unreachable`, whatever the honoured set
 * says: an entry for an agent Genie never asked can only be stale, and reading it would
 * announce a pause nobody requested.
 *
 * There is no separate test against `pauses.unreachable` here, and that is MEASURED rather than
 * assumed: a break probe deleting one showed the tests still green, because `conflictPauses`
 * partitions every conflict into exactly one of requests / unreachable / unclaimed — so "not in
 * requests" already covers it. Two checks for one condition would be a second opinion that can
 * drift from the first.
 */
export function conflictPauseState(
    conflict: FileConflict,
    pauses: ConflictPauses,
    honoured: ReadonlySet<string>,
): PauseState {
    if (conflict.who === null || conflict.agentId === null) return 'unclaimed';
    if (!pauses.requests.some((request) => request.path === conflict.path)) return 'unreachable';
    return honoured.has(conflict.path) ? 'paused' : 'asking';
}

/**
 * The tree's single-letter change marker, or `null` for a file with nothing to mark.
 *
 * Git's OWN letters, including the three the board does not name: a renamed file is not a
 * modified one, and `U` is what git calls untracked. Inventing a letter, or folding them into
 * `M`, would make the tree say something git did not.
 *
 * `null` status ⇒ no marker at all, because a marker is a state claim and git made none. An
 * IGNORED file is not news either — the same rule `changedFilePaths` applies.
 */
export function changeMarker(
    status: GitFileStatus | null,
): { letter: string; tone: 'amber' | 'emerald' | 'red' } | null {
    switch (status) {
        case 'modified':
            return { letter: 'M', tone: 'amber' };
        case 'renamed':
            return { letter: 'R', tone: 'amber' };
        case 'added':
            return { letter: 'A', tone: 'emerald' };
        case 'untracked':
            return { letter: 'U', tone: 'emerald' };
        case 'deleted':
            return { letter: 'D', tone: 'red' };
        default:
            return null;
    }
}

/**
 * WHAT THE SCAN COULD NOT LOOK AT, or `null` when it looked at everything.
 *
 * The conflicts themselves get a banner each ({@link conflictTitle}); this is the sentence
 * that has no banner of its own, and it is the one most easily left out. A scan that could not
 * read every tab must not render as silence: zero conflicts out of the tabs it COULD read is
 * not zero conflicts, and silence is the reassuring answer arriving by default — the whole
 * failure mode `file-panel-states.ts` was written against.
 *
 * Two different blindnesses, one count: a dirty tab whose disk text is missing
 * (`ConflictScan.unreadable`) and one whose own buffer cannot be compared (`opaque`). The
 * human's question is "is this panel telling me everything", and the answer is a number.
 */
export function uncheckedNotice(scan: ConflictScan, opaque: number): string | null {
    const unchecked = scan.unreadable + opaque;
    if (unchecked === 0) return null;
    return `${unchecked} open ${unchecked === 1 ? 'tab' : 'tabs'} could not be checked for collisions.`;
}

/** One row of the panel's changes list. */
export interface ChangeRow {
    path: string;
    /** When the newest REPORTED write landed, or `0` when none was — a git-only change has no
     *  timestamp, and `0` is how the row says so rather than a date from the epoch. */
    at: number;
    who: string | null;
    /** The author, or `'?'`. {@link diskWriteMarks} decides it; this does not re-derive it. */
    label: string;
    tone: 'status' | 'neutral';
    /** `true` contested, `false` measured clear, **`null` nobody scanned**. A `false` on an
     *  unscanned row would tell the user their unsaved edit is safe on no evidence. */
    conflict: boolean | null;
}

/**
 * The changes list, with the attribution `diskWriteMarks` earned and nothing added to it.
 *
 * The path set is {@link diskWriteMarks}', which is `changedFilePaths`', so this list shows a
 * file GIT reports that no agent ever mentioned — §5.3's unattributed write, and the case the
 * panel's old inline list could not show at all because it iterated the reported changes only.
 * Order is the order handed in (already newest-first from `sessionFileChanges`) with the
 * git-only paths after it; re-sorting would be a second opinion about one set of timestamps.
 */
export function changeRows(
    changes: SessionFileChange[],
    gitStatus: GitStatusMap,
    conflicts: string[] | null,
): ChangeRow[] {
    const stamps = new Map(changes.map((change) => [change.path, change.at]));
    const contested = conflicts === null ? null : new Set(conflicts);
    return diskWriteMarks(changes, gitStatus).map((mark) => ({
        path: mark.path,
        at: stamps.get(mark.path) ?? 0,
        who: mark.who,
        label: mark.label,
        tone: mark.tone,
        conflict: contested === null ? null : contested.has(mark.path),
    }));
}
