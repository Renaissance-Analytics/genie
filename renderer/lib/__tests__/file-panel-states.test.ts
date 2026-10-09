import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { emptyAgentSession, type AgentSession } from '../../../main/agentsession/model';
import type { GitStatusMap } from '../genie';
import type { SessionFileChange } from '../workspace-file-panel';
import {
    conflictPauses,
    conflictPaths,
    diskWriteMarks,
    filePanelSlot,
    poppedWindowIntent,
    repoLockNotice,
    repoLockState,
    scanConflicts,
    singlePoppedPanel,
    UNATTRIBUTED_MARK,
    type OpenTab,
} from '../file-panel-states';

/**
 * §5.3's MISSING PANEL STATES — conflict, stale lock, unattributed write, popped out.
 *
 * Each of these is a claim Genie makes about somebody's code, so every assertion below is
 * about the claim being EARNED. Three of the four states exist to say "I cannot tell you"
 * precisely, and the tests that matter most are the ones proving a missing answer is not
 * silently rendered as a reassuring one.
 */

const BASE = ['l0', 'l1', 'l2', 'l3', 'l4', 'l5', 'l6', 'l7', 'l8', 'l9'].join('\n');

/** The baseline with line `n` rewritten — a `replace` hunk at `[n, n+1)`. */
function rewrite(n: number, text: string): string {
    return BASE.split('\n')
        .map((line, index) => (index === n ? text : line))
        .join('\n');
}

/** The baseline with `text` inserted BEFORE line `n` — an `add` at the seam `n`. */
function insertAt(n: number, text: string): string {
    const lines = BASE.split('\n');
    lines.splice(n, 0, text);
    return lines.join('\n');
}

/** The baseline with lines `[from, to)` all rewritten — one `replace` hunk over the block. */
function rewriteBlock(from: number, to: number): string {
    return BASE.split('\n')
        .map((line, index) => (index >= from && index < to ? `BLK${index}` : line))
        .join('\n');
}

function tab(over: Partial<OpenTab> & { path: string }): OpenTab {
    return { baseline: BASE, buffer: BASE, disk: BASE, ...over };
}

function change(path: string, who: string | null, at = 1_000): SessionFileChange {
    return { path, who, agentId: who === null ? null : `id-${who}`, at };
}

function session(agentId: string, name: string, specId: string | null): AgentSession {
    return emptyAgentSession(
        { agentId, specId, provider: 'claude', name, cwd: 'C:/ws', workspaceId: 'w' },
        0,
    );
}

describe('error · the human and an agent on the same lines', () => {
    it('reports a collision only where the two hunks MEET, with a far-apart pair as the control', () => {
        // The human rewrote line 2; the agent's write landed on line 8. Both files differ from
        // the baseline, which is exactly the case a file-level check would call a conflict.
        const apart = scanConflicts({
            tabs: [tab({ path: 'a.ts', buffer: rewrite(2, 'MINE'), disk: rewrite(8, 'THEIRS') })],
            changes: [change('a.ts', 'atlas')],
        });
        expect(apart.conflicts).toHaveLength(0);

        // POSITIVE CONTROL: move the agent's write onto the human's line and the SAME scan
        // finds it. Without this, the zero above would also pass on a scanner that can see
        // nothing at all.
        const together = scanConflicts({
            tabs: [tab({ path: 'a.ts', buffer: rewrite(2, 'MINE'), disk: rewrite(2, 'THEIRS') })],
            changes: [change('a.ts', 'atlas')],
        });
        expect(together.conflicts).toHaveLength(1);
        expect(together.conflicts[0]!.path).toBe('a.ts');
        // BASELINE coordinates — the only system both edits can be expressed in. Line 2,
        // half-open.
        expect(together.conflicts[0]!.lines).toEqual([{ start: 2, end: 3 }]);
    });

    it('names the writer when one claimed the file, and NOBODY when none did', () => {
        const claimed = scanConflicts({
            tabs: [tab({ path: 'a.ts', buffer: rewrite(2, 'MINE'), disk: rewrite(2, 'THEIRS') })],
            changes: [change('a.ts', 'atlas')],
        });
        expect([claimed.conflicts[0]!.who, claimed.conflicts[0]!.agentId]).toEqual(['atlas', 'id-atlas']);

        // The same collision with no reported write. It is still a collision — the lines
        // really did both move — but Genie does not guess who did it.
        const unclaimed = scanConflicts({
            tabs: [tab({ path: 'a.ts', buffer: rewrite(2, 'MINE'), disk: rewrite(2, 'THEIRS') })],
            changes: [],
        });
        expect(unclaimed.conflicts).toHaveLength(1);
        expect([unclaimed.conflicts[0]!.who, unclaimed.conflicts[0]!.agentId]).toEqual([null, null]);
    });

    it('needs an UNSAVED edit: a clean tab reloads and has nothing to lose', () => {
        // CodePanel reloads a clean tab from disk, so a divergence there is not a collision —
        // it is a pending refresh.
        expect(scanConflicts({
            tabs: [tab({ path: 'a.ts', buffer: BASE, disk: rewrite(2, 'THEIRS') })],
            changes: [change('a.ts', 'atlas')],
        }).conflicts).toHaveLength(0);

        // POSITIVE CONTROL: the identical disk text against a DIRTY buffer on those lines.
        expect(scanConflicts({
            tabs: [tab({ path: 'a.ts', buffer: rewrite(2, 'MINE'), disk: rewrite(2, 'THEIRS') })],
            changes: [change('a.ts', 'atlas')],
        }).conflicts).toHaveLength(1);

        /**
         * And a clean tab Genie could not read is not counted as a partial answer either.
         *
         * This assertion is the one that actually DISTINGUISHES the clean-tab rule. Measured by
         * break probe: deleting the `buffer === baseline` guard leaves the two assertions above
         * green — identical texts produce no ranges, so they would pass for a second reason —
         * and turns this one red. Without it the test would be named for a rule it does not test.
         */
        expect(scanConflicts({ tabs: [tab({ path: 'a.ts', disk: null })], changes: [] }).unreadable).toBe(0);
    });

    it('COUNTS the dirty tabs whose disk text it could not read instead of calling them clean', () => {
        const blind = scanConflicts({
            tabs: [tab({ path: 'a.ts', buffer: rewrite(2, 'MINE'), disk: null })],
            changes: [change('a.ts', 'atlas')],
        });
        // `null` disk is "cannot see". Nothing is reported as a conflict, and nothing is
        // reported as safe either — the count is how the surface says the scan is partial.
        expect(blind.conflicts).toHaveLength(0);
        expect(blind.unreadable).toBe(1);

        // POSITIVE CONTROL: the same tab with its disk text present is readable AND colliding.
        const read = scanConflicts({
            tabs: [tab({ path: 'a.ts', buffer: rewrite(2, 'MINE'), disk: rewrite(2, 'THEIRS') })],
            changes: [change('a.ts', 'atlas')],
        });
        expect(read.unreadable).toBe(0);
        expect(read.conflicts).toHaveLength(1);
    });

    it('discards nothing — the scan reads the texts and returns ranges, never a merge', () => {
        const tabs = [tab({ path: 'a.ts', buffer: rewrite(2, 'MINE'), disk: rewrite(2, 'THEIRS') })];
        const before = JSON.stringify(tabs);
        const scan = scanConflicts({ tabs, changes: [] });
        expect(JSON.stringify(tabs)).toBe(before);
        // And the result carries no text at all, so no consumer can mistake it for a resolution.
        expect(Object.keys(scan.conflicts[0]!).sort()).toEqual(['agentId', 'lines', 'path', 'who']);
    });

    it('treats an insertion by its SEAM: the same seam collides, a block edge does not', () => {
        const seam = (mine: string, theirs: string) =>
            scanConflicts({ tabs: [tab({ path: 'a.ts', buffer: mine, disk: theirs })], changes: [] })
                .conflicts.length;

        // Two insertions at one seam both want text in the same place.
        expect(seam(insertAt(5, 'MINE'), insertAt(5, 'THEIRS'))).toBe(1);
        // An insertion STRICTLY INSIDE a block the agent replaced lands in rewritten lines.
        expect(seam(insertAt(5, 'MINE'), rewriteBlock(4, 7))).toBe(1);
        // At the block's top edge it does not: the insertion goes BEFORE the replaced lines,
        // which is what a three-way merge resolves without asking anybody.
        expect(seam(insertAt(4, 'MINE'), rewriteBlock(4, 7))).toBe(0);
        // Two insertions at DIFFERENT seams are independent.
        expect(seam(insertAt(2, 'MINE'), insertAt(8, 'THEIRS'))).toBe(0);
    });

    it('keeps "no conflicts" and "nobody scanned" apart for the Changes tab', () => {
        // `agentChangesView` takes `conflicts?: string[] | null` and documents null as "nobody
        // looked". This is the bridge, and it must not flatten the two.
        expect(conflictPaths(null)).toBeNull();
        expect(conflictPaths(scanConflicts({ tabs: [], changes: [] }))).toEqual([]);
        expect(conflictPaths(scanConflicts({
            tabs: [tab({ path: 'a.ts', buffer: rewrite(2, 'MINE'), disk: rewrite(2, 'THEIRS') })],
            changes: [],
        }))).toEqual(['a.ts']);
    });
});

describe('error · pausing the agent on the file', () => {
    const colliding = (who: string | null) => scanConflicts({
        tabs: [tab({ path: 'a.ts', buffer: rewrite(2, 'MINE'), disk: rewrite(2, 'THEIRS') })],
        changes: who === null ? [] : [change('a.ts', who)],
    });

    it('asks the agent that holds the file, by its LIVE terminal', () => {
        const pauses = conflictPauses(colliding('atlas'), [session('id-atlas', 'atlas', 'spec-1')]);
        expect(pauses.requests).toEqual([
            { path: 'a.ts', who: 'atlas', agentId: 'id-atlas', specId: 'spec-1' },
        ]);
        expect(pauses.unreachable).toHaveLength(0);
        expect(pauses.unclaimed).toBe(0);
    });

    it('COUNTS an agent it cannot ask rather than reporting a pause it never requested', () => {
        // A dormant agent has no terminal, so there is no session to cancel. The collision is
        // real and the pause half of the notice is not deliverable — which the surface has to
        // be able to say.
        const dormant = conflictPauses(colliding('atlas'), [session('id-atlas', 'atlas', null)]);
        expect(dormant.requests).toHaveLength(0);
        expect(dormant.unreachable).toEqual([{ path: 'a.ts', who: 'atlas', agentId: 'id-atlas' }]);

        // An agent Genie holds no session for at all is equally unreachable.
        expect(conflictPauses(colliding('atlas'), []).unreachable).toHaveLength(1);

        // POSITIVE CONTROL: give that same agent a terminal and it becomes a request.
        expect(conflictPauses(colliding('atlas'), [session('id-atlas', 'atlas', 'spec-1')]).requests)
            .toHaveLength(1);
    });

    it('asks NOBODY for an unattributed collision, and counts it', () => {
        const nobody = conflictPauses(colliding(null), [session('id-atlas', 'atlas', 'spec-1')]);
        expect(nobody.requests).toHaveLength(0);
        expect(nobody.unreachable).toHaveLength(0);
        expect(nobody.unclaimed).toBe(1);
    });
});

describe('error · a stale git lock', () => {
    const LOCK = '.git/index.lock';

    it('says it CANNOT SEE when it could not look, which is not the same as no lock', () => {
        expect(repoLockState([]).kind).toBe('unseen');
        expect(repoLockState([{ at: 0, present: null }, { at: 30_000, present: null }]).kind).toBe('unseen');
        // POSITIVE CONTROL: a probe that DID look and found nothing says so.
        expect(repoLockState([{ at: 0, present: false }]).kind).toBe('none');
    });

    it('will not call a lock stale on one sighting — git holds it for milliseconds', () => {
        expect(repoLockState([{ at: 0, present: true }]).kind).toBe('held');
    });

    it('calls it stale only once it has OUTLIVED a git command, and says how to clear it', () => {
        const probes = [{ at: 0, present: true }, { at: 11_000, present: true }];
        // POSITIVE CONTROL first: the same two sightings inside the window are merely held.
        expect(repoLockState([{ at: 0, present: true }, { at: 900, present: true }]).kind).toBe('held');

        const stale = repoLockState(probes, { lockPath: LOCK });
        expect(stale.kind).toBe('stale');
        if (stale.kind !== 'stale') throw new Error('unreachable');
        expect(stale.heldForMs).toBe(11_000);
        expect(stale.lockPath).toBe(LOCK);
        // The fix names the file, because "a lock is stuck" with no path is not a fix.
        expect(stale.fix).toContain(LOCK);
    });

    it('restarts the clock when the lock CLEARS — a new lock is not an old one', () => {
        const restarted = repoLockState([
            { at: 0, present: true },
            { at: 11_000, present: false },
            { at: 12_000, present: true },
        ]);
        expect(restarted.kind).toBe('held');

        // POSITIVE CONTROL: the identical span with no gap IS stale.
        expect(repoLockState([
            { at: 0, present: true },
            { at: 11_000, present: true },
            { at: 12_000, present: true },
        ]).kind).toBe('stale');
    });

    it('ignores a probe that could not look WITHOUT treating it as the lock clearing', () => {
        // A failed probe is silence, not absence. Reading it as "gone" would reset the clock
        // and a stale lock would never be reported on a flaky filesystem.
        expect(repoLockState([
            { at: 0, present: true },
            { at: 5_000, present: null },
            { at: 11_000, present: true },
        ]).kind).toBe('stale');
    });

    it('puts a notice on the chip ONLY for a lock it can prove, never for one it cannot see', () => {
        expect(repoLockNotice(repoLockState([]))).toBeNull();
        expect(repoLockNotice(repoLockState([{ at: 0, present: false }]))).toBeNull();
        expect(repoLockNotice(repoLockState([{ at: 0, present: true }]))).toBeNull();
        const notice = repoLockNotice(repoLockState([{ at: 0, present: true }, { at: 11_000, present: true }]));
        expect(notice).toContain('.git/index.lock');
    });
});

describe('cannot see · an unattributed write', () => {
    const marks = (changes: SessionFileChange[], gitStatus: GitStatusMap = {}) =>
        new Map(diskWriteMarks(changes, gitStatus).map((mark) => [mark.path, mark]));

    it('marks a change nobody reported with a "?" in neutral grey, and names the one that was', () => {
        const map = marks(
            [change('mine.ts', 'atlas'), change('theirs.ts', null)],
            { 'mine.ts': 'modified', 'theirs.ts': 'modified' },
        );
        expect(map.get('theirs.ts')).toEqual({
            path: 'theirs.ts', who: null, label: UNATTRIBUTED_MARK, tone: 'neutral', touchedOnDisk: true,
        });
        // POSITIVE CONTROL: the claimed file in the same scan carries its author and keeps
        // git's own colour, so the grey above is attribution and not a flat repaint.
        expect(map.get('mine.ts')).toEqual({
            path: 'mine.ts', who: 'atlas', label: 'atlas', tone: 'status', touchedOnDisk: false,
        });
    });

    it('marks only what CHANGED — counted, so a tight filter cannot read as a quiet workspace', () => {
        const all = diskWriteMarks([change('a.ts', 'atlas')], { 'a.ts': 'modified', 'b.ts': 'modified' });
        expect(all).toHaveLength(2);
        // An unchanged, unreported file is not in the list at all.
        expect(all.map((mark) => mark.path).includes('untouched.ts')).toBe(false);
        expect(diskWriteMarks([], {}).length).toBe(0);
    });

    it('leaves an IGNORED file alone unless an agent reported writing it', () => {
        // `changedFilePaths` drops ignored paths: an ignored file nobody claimed is not news.
        expect(marks([], { 'node_modules/x.js': 'ignored' }).size).toBe(0);
        // POSITIVE CONTROL: a reported write to one IS news, and keeps its author.
        const reported = marks([change('node_modules/x.js', 'atlas')], { 'node_modules/x.js': 'ignored' });
        expect(reported.get('node_modules/x.js')?.who).toBe('atlas');
    });

    it('counts the unattributed separately from the total', () => {
        const summary = diskWriteMarks(
            [change('a.ts', 'atlas'), change('b.ts', null), change('c.ts', null)],
            {},
        );
        expect(summary.filter((mark) => mark.who === null)).toHaveLength(2);
        expect(summary.filter((mark) => mark.tone === 'neutral')).toHaveLength(2);
        expect(summary).toHaveLength(3);
    });
});

describe('popped out · one window, and a bar back', () => {
    it('shows the bring-back bar only for a panel THIS workspace popped', () => {
        const popped = filePanelSlot({ popped: true, owned: false, closed: false, local: true });
        expect(popped.kind).toBe('popped');
        expect([popped.bar, popped.canBringBack]).toEqual([true, true]);

        // Another window owns the panel without this workspace having popped it (a second
        // master window). There is a window to FOCUS but nothing here to bring back.
        const elsewhere = filePanelSlot({ popped: false, owned: false, closed: false, local: true });
        expect(elsewhere.kind).toBe('elsewhere');
        expect([elsewhere.bar, elsewhere.canBringBack]).toEqual([false, false]);
    });

    it('a CLOSED panel looks the same and carries no bar', () => {
        const closed = filePanelSlot({ popped: false, owned: true, closed: true, local: true });
        expect(closed.kind).toBe('closed');
        expect([closed.bar, closed.canBringBack]).toEqual([false, false]);
        // POSITIVE CONTROL: the identical input still open renders the panel itself.
        expect(filePanelSlot({ popped: false, owned: true, closed: false, local: true }).kind).toBe('panel');
        // Closing wins over popped: ⌘B on a popped panel leaves no bar behind.
        expect(filePanelSlot({ popped: true, owned: false, closed: true, local: true }).kind).toBe('closed');
    });

    it('does not claim a claim it has not got, or one a remote window cannot make', () => {
        expect(filePanelSlot({ popped: false, owned: null, closed: false, local: true }).kind).toBe('opening');
        // A remote window never claims the local panel, so it renders the panel rather than
        // sitting forever on "opening".
        expect(filePanelSlot({ popped: false, owned: null, closed: false, local: false }).kind).toBe('panel');
    });

    it('keeps ONE popped window per workspace, and COUNTS any duplicate it is handed', () => {
        const panels = [
            { workspaceId: 'w', specId: 'first' },
            { workspaceId: 'w', specId: 'second' },
            { workspaceId: 'other', specId: 'third' },
        ];
        const one = singlePoppedPanel(panels, 'w');
        expect(one.specId).toBe('first');
        expect(one.duplicates).toBe(1);

        // POSITIVE CONTROL: a single entry is one window with nothing left over.
        expect(singlePoppedPanel([{ workspaceId: 'w', specId: 'first' }], 'w'))
            .toEqual({ specId: 'first', duplicates: 0 });
        // And no entry is no window — null, not a spec id belonging to another workspace.
        expect(singlePoppedPanel(panels, 'missing')).toEqual({ specId: null, duplicates: 0 });
    });

    it('has the popped window ASK the resolver rather than matching the key again', () => {
        const source = fs.readFileSync(
            path.resolve(import.meta.dirname, '../../components/Code/WorkspaceFilesWindow.tsx'),
            'utf8',
        );
        // POSITIVE CONTROL: the file really was read and is the one meant — without this, both
        // assertions below would also pass on an empty string or the wrong path.
        expect(source).toContain('export default function WorkspaceFilesWindow');
        expect(source).toContain("poppedWindowIntent(event) !== 'close-window'");
        // And it does not define a SECOND keyboard model for the same chord.
        expect(source).not.toMatch(/key === 'b'|key === 'B'|KeyB/);
    });

    it('closes the popped window on the SAME chord that opens the panel', () => {
        const chord = { key: 'b', metaKey: true, ctrlKey: false, altKey: false, shiftKey: false };
        expect(poppedWindowIntent(chord)).toBe('close-window');
        expect(poppedWindowIntent({ ...chord, metaKey: false, ctrlKey: true })).toBe('close-window');
        // A bare `b` is a letter somebody is typing.
        expect(poppedWindowIntent({ ...chord, metaKey: false })).toBeNull();
        // And the window does not inherit the rest of the master keyboard — there is no deck
        // here to show, so ⌘K must not resolve to anything.
        expect(poppedWindowIntent({ ...chord, key: 'k' })).toBeNull();
    });
});
