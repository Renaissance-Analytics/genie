import { computeDiff, type LineRange } from '@particle-academy/fancy-file-commons';
import type { AgentSession } from '../../main/agentsession/model';
import type { GitStatusMap } from './genie';
import { resolveShortcut, type FocusOwner, type ShortcutKeyEvent } from './master-shortcuts';
import { changedFilePaths, type SessionFileChange } from './workspace-file-panel';

/**
 * THE PANEL'S REMAINING STATES — §5.3's conflict, stale lock, unattributed write, popped out.
 *
 * The default panel and its Changed filter already exist (`workspace-file-panel.ts`,
 * `agent-files-view.ts`, `agent-changes-view.ts`). What was missing is every state in which the
 * panel has to say something UNWELCOME: two people on the same lines, a repo git has locked
 * itself out of, a write nobody will claim, and a panel that is not here any more.
 *
 * Three of the four are "cannot see" states, and that is the whole difficulty. Each one has a
 * reassuring answer sitting right next to the honest one — no conflict, no lock, nobody wrote
 * it — and the reassuring answer is the one that arrives by default if nobody writes the code
 * carefully. So every function here distinguishes *looked and found nothing* from *could not
 * look*, and counts what it had to leave out.
 *
 * ## Reused, not reinvented
 *
 * - **Attribution** is `agent-files-view.ts`'s, down to the vocabulary: `touchedOnDisk` means
 *   the newest write to a file is one no agent claimed, and an unclaimed write is COUNTED and
 *   never attributed. Two answers to "who changed this file" would eventually disagree, and the
 *   one that already exists is the one with the tests.
 * - **The conflict list** is `agent-changes-view.ts`'s `conflicts` input, which that file
 *   deliberately left as an input: *"the collision state, which Genie cannot see from an
 *   `AgentSession` at all"*. {@link scanConflicts} is the producer it was waiting for, and
 *   {@link conflictPaths} is the bridge — preserving its `null` ⇒ nobody looked.
 * - **The diff** is Fancy's `computeDiff`, already used by `agent-changes-view.ts` for its line
 *   counts and by `fancy-git-ui`'s `DiffViewer`. A hand-rolled line comparison would be a
 *   second opinion about the same bytes.
 * - **The chord** is `master-shortcuts.ts`'s. ⌘B already resolves to `files`; the popped window
 *   maps that one intent onto closing itself rather than defining a second keyboard model.
 *
 * ## What could NOT be sourced, named so it is not mistaken for finished
 *
 * **Nothing in Genie reports a git lock.** `main/files/ipc.ts`'s `gitStatus` catches every
 * failure and returns `{}` — *"Not a repo, git missing, timeout, etc. → no colouring"* — so a
 * locked repo is indistinguishable from a clean one at that boundary, and a search of `main/`
 * finds no other producer. {@link repoLockState} therefore consumes OBSERVATIONS of the lock
 * file (`files.exist(workspacePath, ['.git/index.lock'])`, an IPC that already exists and whose
 * `guardedResolve` permits the path) rather than a signal that does not exist. Two consequences
 * are honest limits, not oversights:
 *
 *  1. **Staleness is observed, not read.** No IPC returns an mtime, so "stale" here means *the
 *     lock was still there when we looked again*. A real `git status` holds `index.lock` for
 *     milliseconds; one present across probes ten seconds apart is stuck. That is a measurement
 *     this module can actually make.
 *  2. **A worktree or submodule is BLIND.** Its `.git` is a file, so `.git/index.lock` does not
 *     resolve, and the real git dir is outside the workspace root where `guardedResolve` will
 *     not follow. The probe reports `present: null` there, and `null` propagates to `unseen` —
 *     never to `none`.
 */

/** How long a lock must survive being looked at twice before it is called stuck. */
const STALE_LOCK_MS = 10_000;

/** Where git puts the lock in a repo whose `.git` is a real directory. */
const INDEX_LOCK = '.git/index.lock';

/** The mark an unclaimed write carries. Not a name, and not blank — a blank cell reads as
 *  "unchanged", and §5.3 asks for a '?' precisely because the question is open. */
export const UNATTRIBUTED_MARK = '?';

// ─────────────────────────────────────────────────────────────────────────────
// Error · conflict
// ─────────────────────────────────────────────────────────────────────────────

/** One open tab, as the three texts a collision is decided from. */
export interface OpenTab {
    /** Workspace-relative, because everything else in the panel is. */
    path: string;
    /** What the editor loaded or last saved — `CodePanel`'s `baseline`, and the COMMON
     *  ANCESTOR of the other two texts. Every range below is in its coordinates. */
    baseline: string;
    /** The live buffer. Equal to `baseline` ⇒ the tab is clean and has nothing to lose. */
    buffer: string;
    /** The file as it is on disk NOW. `null` ⇒ Genie could not read it — binary, deleted,
     *  truncated, or a failed read. Not "unchanged": see {@link ConflictScan.unreadable}. */
    disk: string | null;
}

export interface FileConflict {
    path: string;
    /**
     * Where the human's unsaved edit meets the writer's, in BASELINE line coordinates,
     * half-open and in order. Never empty — a conflict with no colliding range is not one.
     *
     * The HUMAN's ranges, not the intersection: this is what they have to look at. An empty
     * range (`start === end`) is an insertion seam, which is a position rather than a span.
     */
    lines: LineRange[];
    /**
     * Where the WRITER's colliding hunks are, in the same baseline coordinates.
     *
     * A different measurement from {@link lines} and the notice needs both — *"atlas changed
     * lines 13–16 while you had unsaved edits to line 13"*. Printing one range for both would
     * tell the user the agent touched exactly the lines they did.
     *
     * FILTERED to the hunks that actually collide. A hunk of theirs at the other end of the
     * file is not part of this collision, and naming it would widen the claim.
     */
    theirLines: LineRange[];
    /** The agent that wrote the file, by name. `null` ⇒ nobody claimed the write, and Genie
     *  does not guess — the collision is still real. */
    who: string | null;
    agentId: string | null;
}

export interface ConflictScan {
    /** One entry per colliding file. `[]` ⇒ somebody looked and found none. */
    conflicts: FileConflict[];
    /**
     * DIRTY tabs whose on-disk text could not be read, so Genie cannot say whether they
     * collide. A count, so a surface can say the scan is partial rather than implying it is
     * complete. Clean tabs are excluded: there is nothing at risk in one, so counting it would
     * pad the number with files that need no answer.
     */
    unreadable: number;
}

/**
 * The changed line ranges of `after` against `before`, in BEFORE coordinates.
 *
 * MEASURED, and this is the load-bearing detail: for a pure insertion `computeDiff` reports
 * `beforeRange: { start: 0, end: 0 }` **wherever the insertion is** — probed against
 * `fancy-file-commons` with a ten-line document, inserting at line 5:
 *
 *     [["equal",{0,5},{0,5}], ["add",{0,0},{5,6}], ["equal",{5,10},{6,11}]]
 *
 * So an `add` hunk's own `beforeRange` cannot locate it, and anything built on it would place
 * every insertion at line 0 — where it would collide with whatever the other side did to the
 * top of the file. The position is taken from the surrounding `equal` hunks instead, whose
 * ranges are well defined on both sides. (`agent-changes-view.ts` is unaffected: it sums hunk
 * SIZES, and an insertion's before-size really is zero.)
 */
function baselineRanges(before: string, after: string): LineRange[] {
    const ranges: LineRange[] = [];
    let cursor = 0;
    for (const hunk of computeDiff(before, after, { segment: false }).hunks) {
        if (hunk.type === 'equal') {
            cursor = hunk.beforeRange.end;
            continue;
        }
        if (hunk.type === 'add') {
            // A seam, at the baseline position the preceding equal hunk ended on.
            ranges.push({ start: cursor, end: cursor });
            continue;
        }
        ranges.push({ start: hunk.beforeRange.start, end: hunk.beforeRange.end });
        cursor = hunk.beforeRange.end;
    }
    return ranges;
}

/**
 * Whether two baseline ranges hit the same lines.
 *
 * Spans use half-open intersection. Seams need their own rules, because a half-open empty range
 * intersects nothing and an insertion would then never conflict with anything:
 *
 *  - **Two seams** collide when they are the SAME seam — both sides want text in one place.
 *  - **A seam inside a span** collides only STRICTLY inside it. At a span's own edge the
 *    insertion goes before the first replaced line, which is the case a three-way merge settles
 *    without asking anybody — and a conflict notice nobody needed is how a person learns to
 *    dismiss them unread.
 */
function touches(a: LineRange, b: LineRange): boolean {
    const aSeam = a.start === a.end;
    const bSeam = b.start === b.end;
    if (aSeam && bSeam) return a.start === b.start;
    if (aSeam) return a.start > b.start && a.start < b.end;
    if (bSeam) return b.start > a.start && b.start < a.end;
    return a.start < b.end && b.start < a.end;
}

/**
 * Which open tabs the human and a writer are both inside, at line granularity.
 *
 * §5.3: *"Your unsaved edit and an agent's hunk hit the same lines. Nothing is discarded and
 * the agent pauses on the file."* Both halves are load-bearing. Nothing is discarded because
 * nothing here writes: `CodePanel` already refuses to reload a dirty tab
 * (*"never clobber unsaved edits"*), so the buffer is safe before this runs — what was missing
 * is anyone SAYING SO. A silent divergence is the failure this replaces.
 *
 * Line granularity rather than file is the point. The agent's own tool calls carry no line
 * ranges (`workspace-changes.ts` says so, and declines to estimate), but the three TEXTS do:
 * baseline → buffer is what the human changed, baseline → disk is what landed, and both are
 * expressed against the same ancestor. A file-level check would cry conflict every time an
 * agent touched the other end of a file somebody had open.
 */
export function scanConflicts(input: { tabs: OpenTab[]; changes: SessionFileChange[] }): ConflictScan {
    // `changes` has already been through `sessionFileChanges`, which strips the author when a
    // disk event is newer than the newest reported write. So a null `who` here is the existing
    // attribution rule's answer, not a lookup miss.
    const byPath = new Map(input.changes.map((change) => [change.path, change]));
    const conflicts: FileConflict[] = [];
    let unreadable = 0;

    for (const tab of input.tabs) {
        if (tab.buffer === tab.baseline) continue; // clean: CodePanel reloads it, nothing to lose
        if (tab.disk === null) {
            unreadable += 1;
            continue;
        }
        if (tab.disk === tab.baseline) continue; // nobody else has been here
        const theirs = baselineRanges(tab.baseline, tab.disk);
        const lines = baselineRanges(tab.baseline, tab.buffer)
            .filter((mine) => theirs.some((their) => touches(mine, their)));
        if (lines.length === 0) continue;
        const change = byPath.get(tab.path);
        conflicts.push({
            path: tab.path,
            lines,
            // Symmetric to `lines` and through the same `touches` rule, so the two halves of
            // the notice cannot disagree about what collided.
            theirLines: theirs.filter((their) => lines.some((mine) => touches(mine, their))),
            who: change?.who ?? null,
            agentId: change?.agentId ?? null,
        });
    }

    return { conflicts, unreadable };
}

/**
 * The scan as `agent-changes-view.ts` takes it: `string[] | null`, where **null means nobody
 * looked**. Passing `[]` for a scan that never ran would tell every Changes row it is in the
 * clear on the strength of no evidence at all.
 */
export function conflictPaths(scan: ConflictScan | null): string[] | null {
    return scan === null ? null : scan.conflicts.map((conflict) => conflict.path);
}

/** One agent to ask to stop, and the terminal to ask through. */
export interface PauseRequest {
    path: string;
    who: string;
    agentId: string;
    /** Its live terminal — what `api().agentSession.cancel` takes. */
    specId: string;
}

export interface ConflictPauses {
    /**
     * The asks that can actually be made. `agentSession.cancel` only ASKS — *"honoured is a
     * real answer either way"* — so a request here is a request, and a surface must report what
     * came back rather than announcing a pause it merely tried for.
     */
    requests: PauseRequest[];
    /** Agents holding a colliding file that Genie cannot reach: dormant (no terminal) or not in
     *  the roster at all. Listed, because "the agent pauses" is then not true and the human is
     *  the only one who can stop it. */
    unreachable: Array<{ path: string; who: string; agentId: string }>;
    /** Collisions with no author to ask. Counted — there is no one to pause, and the file is
     *  still contested. */
    unclaimed: number;
}

/** Who to ask to stop, for each colliding file — and who cannot be asked. */
export function conflictPauses(scan: ConflictScan, sessions: AgentSession[]): ConflictPauses {
    const byAgent = new Map(sessions.map((session) => [session.agentId, session]));
    const result: ConflictPauses = { requests: [], unreachable: [], unclaimed: 0 };
    for (const conflict of scan.conflicts) {
        if (conflict.agentId === null || conflict.who === null) {
            result.unclaimed += 1;
            continue;
        }
        const { path, who, agentId } = { path: conflict.path, who: conflict.who, agentId: conflict.agentId };
        const specId = byAgent.get(agentId)?.specId ?? null;
        if (specId === null) {
            result.unreachable.push({ path, who, agentId });
            continue;
        }
        result.requests.push({ path, who, agentId, specId });
    }
    return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Error · a stale git lock
// ─────────────────────────────────────────────────────────────────────────────

/** One look at the repo's lock file. */
export interface LockProbe {
    /** When the look happened. */
    at: number;
    /** `true` present, `false` absent, **`null` could not look** — a worktree, a submodule, a
     *  failed call. Null is silence and never resets the clock. */
    present: boolean | null;
}

/**
 * What the repo chip can say about a lock.
 *
 * A discriminated union rather than a nullable value, so the two answers that get conflated —
 * `unseen` (nobody could look) and `none` (looked, nothing there) — cannot collapse into one
 * falsy case at a call site. `held` is the third: a lock exists and is probably a running git
 * command, which is not news.
 */
export type RepoLockState =
    | { kind: 'unseen' }
    | { kind: 'none' }
    | { kind: 'held'; heldForMs: number }
    | { kind: 'stale'; heldForMs: number; lockPath: string; fix: string };

/**
 * Read a run of lock probes.
 *
 * Sorted by `at` rather than trusting arrival order: these come from a polling effect, and one
 * late reply would otherwise reorder the run and reset the clock. A `null` probe is skipped
 * entirely — treating it as absence would restart the hold on every failed look, and a lock on
 * a filesystem that occasionally refuses would never be reported.
 */
export function repoLockState(
    probes: LockProbe[],
    opts: { lockPath?: string; staleAfterMs?: number } = {},
): RepoLockState {
    const lockPath = opts.lockPath ?? INDEX_LOCK;
    const staleAfterMs = opts.staleAfterMs ?? STALE_LOCK_MS;
    const ordered = [...probes].sort((first, second) => first.at - second.at);

    let looked = false;
    let heldSince: number | null = null;
    let lastSeen = 0;
    for (const probe of ordered) {
        if (probe.present === null) continue;
        looked = true;
        if (probe.present === false) {
            heldSince = null;
            continue;
        }
        if (heldSince === null) heldSince = probe.at;
        lastSeen = probe.at;
    }

    if (!looked) return { kind: 'unseen' };
    if (heldSince === null) return { kind: 'none' };
    const heldForMs = lastSeen - heldSince;
    if (heldForMs < staleAfterMs) return { kind: 'held', heldForMs };
    return {
        kind: 'stale',
        heldForMs,
        lockPath,
        // The fix NAMES THE FILE. "A git lock is stuck" with no path is a symptom, and the
        // person reading it has to go and find out what this module already knows.
        fix: `Delete ${lockPath} if no git command is running.`,
    };
}

/**
 * The chip's line, or `null` when there is nothing it can honestly say.
 *
 * `unseen` returns null too — the chip stays quiet rather than reporting a clean repo it never
 * managed to look at. Silence is the one claim a surface can make without evidence.
 */
export function repoLockNotice(state: RepoLockState): string | null {
    if (state.kind !== 'stale') return null;
    return `Git lock held for ${Math.round(state.heldForMs / 1000)}s · ${state.fix}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Cannot see · an unattributed write
// ─────────────────────────────────────────────────────────────────────────────

/** How one changed file is labelled in the tree and the changes list. */
export interface DiskWriteMark {
    path: string;
    /** The author, or `null` when nobody reported the write. */
    who: string | null;
    /** What the row shows beside the name: the author, or {@link UNATTRIBUTED_MARK}. */
    label: string;
    /**
     * `status` ⇒ paint it git's colour, which is a statement about the FILE.
     * `neutral` ⇒ §5.3's *"neutral grey"*, which is a statement about the ATTRIBUTION.
     *
     * This is the distinction the tree currently cannot draw: it colours by git status alone,
     * so a modified file nobody claimed is the same amber as one an agent signed for.
     */
    tone: 'status' | 'neutral';
    /** The newest write to this file is unclaimed — `agent-files-view.ts`'s own field and its
     *  own meaning, so the two surfaces cannot disagree about it. */
    touchedOnDisk: boolean;
}

/**
 * Every changed file with the attribution it has EARNED.
 *
 * §5.3: *"A file changed on disk and no agent reported it. It shows in neutral grey with a '?'.
 * Genie does not guess the author."*
 *
 * The path set is `changedFilePaths`', so this view and the Changed filter cannot drift apart —
 * including its rule that an IGNORED file nobody claimed is not news, while a reported write to
 * one is. Unmarked paths are simply absent: a mark on an unchanged file would be a change.
 */
export function diskWriteMarks(changes: SessionFileChange[], gitStatus: GitStatusMap): DiskWriteMark[] {
    const byPath = new Map(changes.map((change) => [change.path, change]));
    return [...changedFilePaths(changes, gitStatus)].map((path) => {
        const who = byPath.get(path)?.who ?? null;
        return {
            path,
            who,
            label: who ?? UNATTRIBUTED_MARK,
            tone: who === null ? 'neutral' : 'status',
            touchedOnDisk: who === null,
        };
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// Popped out
// ─────────────────────────────────────────────────────────────────────────────

export type FilePanelSlotKind =
    /** Render the panel here. */
    | 'panel'
    /** The ownership claim is in flight. */
    | 'opening'
    /** THIS workspace popped it into its own window. */
    | 'popped'
    /** Another window holds it and this one did not send it there. */
    | 'elsewhere'
    /** ⌘B — the panel is gone and the workspace keeps everything else. */
    | 'closed';

export interface FilePanelSlot {
    kind: FilePanelSlotKind;
    /** The bar across the panel's slot. Only a panel THIS workspace popped gets one. */
    bar: boolean;
    /** Whether `files.bringBackPanel` applies. A window this one did not pop is not its to
     *  reel in; offering the button anyway would move somebody else's panel. */
    canBringBack: boolean;
}

/**
 * What stands in the panel's slot.
 *
 * §5.3: *"The panel is in its own window, and there is still only one. The workspace keeps
 * agents and changes; a bar brings the panel back. Closing it (⌘B) looks the same, without the
 * bar."* So `closed` and `popped` are the same layout and differ only in the bar — which is why
 * they are one function: written as two conditions in a component they drift, and the drift
 * shows up as a bring-back button on a panel there is nothing to bring back.
 *
 * `closed` is tested FIRST: ⌘B on a popped panel is a request for the quiet state, and a bar
 * offering to restore what you just dismissed is the wrong answer to it.
 */
export function filePanelSlot(input: {
    popped: boolean;
    /** The local ownership claim: `null` ⇒ still asking. */
    owned: boolean | null;
    closed: boolean;
    /** This is the local window. A remote one never claims the local panel, so it must not
     *  wait on a claim that will never arrive. */
    local: boolean;
}): FilePanelSlot {
    if (input.closed) return { kind: 'closed', bar: false, canBringBack: false };
    if (input.popped) return { kind: 'popped', bar: true, canBringBack: true };
    if (!input.local) return { kind: 'panel', bar: false, canBringBack: false };
    if (input.owned === null) return { kind: 'opening', bar: false, canBringBack: false };
    if (input.owned === false) return { kind: 'elsewhere', bar: false, canBringBack: false };
    return { kind: 'panel', bar: false, canBringBack: false };
}

/**
 * The ONE popped window for a workspace — *"there is still only one"*.
 *
 * `uniqueWorkspaceFilePanels` enforces one panel per workspace in the grid; this is the same
 * rule for the popped windows, and it COUNTS what it had to drop rather than quietly taking the
 * first. A second window for one workspace means two editors over one set of files with
 * independent dirty buffers, so the number is worth having on screen.
 */
export function singlePoppedPanel(
    panels: Array<{ workspaceId: string; specId: string }>,
    workspaceId: string,
): { specId: string | null; duplicates: number } {
    const mine = panels.filter((panel) => panel.workspaceId === workspaceId);
    return { specId: mine[0]?.specId ?? null, duplicates: Math.max(0, mine.length - 1) };
}

/**
 * What a keypress means in the POPPED window.
 *
 * ⌘B already resolves to `files` — *"open (or close) the workspace file panel"*. In its own
 * window that panel IS the window, so the same chord closes it, and the user gets one key for
 * one idea in both places. Delegating to `resolveShortcut` rather than matching `'b'` here also
 * inherits its guards for free: Alt is never part of a Genie chord, a bare letter is a letter,
 * and a focused terminal keeps its own keys.
 *
 * Every other master intent returns `null`: there is no deck, no lanes and no agent slots in
 * this window, and a chord that silently does nothing is better than one that reaches for a
 * surface that is not here.
 */
export function poppedWindowIntent(
    event: ShortcutKeyEvent,
    focus: FocusOwner = 'surface',
): 'close-window' | null {
    return resolveShortcut(event, focus)?.kind === 'files' ? 'close-window' : null;
}
