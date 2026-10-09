import { describe, expect, it } from 'vitest';
import type { GitStatusMap } from '../genie';
import type { SessionFileChange } from '../workspace-file-panel';
import { conflictPauses, repoLockState, scanConflicts } from '../file-panel-states';
import { emptyAgentSession, type AgentSession } from '../../../main/agentsession/model';
import {
    changeMarker,
    changeRows,
    conflictBody,
    conflictPauseState,
    conflictTitle,
    conflictLines,
    uncheckedNotice,
    LOCK_PROBE_PATHS,
    lockProbe,
    openTabsForScan,
    PROBE_KEEP,
    recordProbe,
    type PanelTab,
} from '../file-panel-signals';

/**
 * WHERE §5.3's PANEL STATES GET THEIR INPUTS.
 *
 * `file-panel-states.ts` decided the rules against inputs it declared it could not source —
 * *"Nothing in Genie reports a git lock"*, so it consumes OBSERVATIONS instead. This is the
 * layer that produces those observations out of what Genie's IPC actually returns, and every
 * test here is about the same hazard: `files.exist` answers with a LIST OF PATHS FOUND, so
 * "absent" and "could not look" arrive as the same silence. Reading that silence as absence
 * would hand `repoLockState` a `false` it never measured — and `false` means *looked, nothing
 * there*, which is the one claim this layer is not entitled to make.
 *
 * The rules themselves are not re-tested here; `file-panel-states.test.ts` owns them. What is
 * tested is the JOIN: that a real IPC answer becomes the right input, and that the composition
 * still produces the state the panel is supposed to show.
 */

const BASE = ['l0', 'l1', 'l2', 'l3', 'l4', 'l5', 'l6', 'l7', 'l8', 'l9'].join('\n');

function rewrite(n: number, text: string): string {
    return BASE.split('\n').map((line, index) => (index === n ? text : line)).join('\n');
}

function change(path: string, who: string | null, at = 1_000): SessionFileChange {
    return { path, who, agentId: who === null ? null : `id-${who}`, at };
}

/** The baseline with lines `[from, to)` all rewritten — one `replace` hunk over the block. */
function rewriteBlock(from: number, to: number): string {
    return BASE.split('\n')
        .map((line, index) => (index >= from && index < to ? `BLK${index}` : line))
        .join('\n');
}

function session(agentId: string, name: string, specId: string | null): AgentSession {
    return emptyAgentSession(
        { agentId, specId, provider: 'claude', name, cwd: 'C:/ws', workspaceId: 'w' },
        0,
    );
}

function panelTab(over: Partial<PanelTab> & { path: string }): PanelTab {
    return { content: BASE, baseline: BASE, dirty: false, kind: 'text', ...over };
}

/** A real repo whose `.git` is a DIRECTORY: `files.exist` returns files only, so `.git`
 *  itself never comes back and `.git/HEAD` does — which is the proof we can see inside. */
const REAL_REPO = ['.git/HEAD'];
/** The same repo WITH the lock on the floor. */
const REAL_REPO_LOCKED = ['.git/HEAD', '.git/index.lock'];
/** A worktree or submodule: `.git` is a FILE, so it comes back and nothing under it does. */
const GITFILE = ['.git'];

describe('the lock probe · what `files.exist` can and cannot prove', () => {
    it('reads a lock it can SEE, with the unlocked repo as the control', () => {
        expect(lockProbe(REAL_REPO_LOCKED, 500)).toEqual({ at: 500, present: true });
        // POSITIVE CONTROL: the same repo, same probe, no lock file — `false` is EARNED here
        // because `.git/HEAD` came back, which proves the call could read inside `.git`.
        expect(lockProbe(REAL_REPO, 500)).toEqual({ at: 500, present: false });
    });

    it('says CANNOT SEE for an empty answer instead of "no lock"', () => {
        // `existingFiles` catches every failure and filters the path out, so a refused call, a
        // repo that is not one, and a repo with no lock all arrive as the same empty list.
        // Only the first two are indistinguishable from each other; none of them is `false`.
        expect(lockProbe([], 500)).toEqual({ at: 500, present: null });
        // And it propagates: `null` probes alone can never be read as a clean repo.
        expect(repoLockState([lockProbe([], 0), lockProbe([], 11_000)]).kind).toBe('unseen');
        // POSITIVE CONTROL: one probe that could look turns the same run into a measurement.
        expect(repoLockState([lockProbe(REAL_REPO, 0)]).kind).toBe('none');
    });

    it('is BLIND in a worktree or submodule, where `.git` is a file', () => {
        // `.git` came back from a files-only query, so it is a gitfile: the real git dir is
        // outside the workspace root and `guardedResolve` will not follow it there. There is
        // no lock to find at this path and no way to say there is none.
        expect(lockProbe(GITFILE, 500)).toEqual({ at: 500, present: null });
        // Blindness WINS over an apparently clean look — a worktree answer cannot be trusted
        // even when the probe paths come back half-populated.
        expect(lockProbe(['.git', '.git/HEAD'], 500).present).toBeNull();
        // POSITIVE CONTROL: drop the gitfile and the identical answer reads as a real repo.
        expect(lockProbe(['.git/HEAD'], 500).present).toBe(false);
    });

    it('asks for the paths the STATE module names, so the fix it prints is the file probed', () => {
        // The default `lockPath` in `repoLockState` and the path asked for here have to be the
        // same string, or the notice tells the user to delete a file nobody looked at.
        expect(LOCK_PROBE_PATHS).toContain('.git/index.lock');
        const stale = repoLockState([
            lockProbe(REAL_REPO_LOCKED, 0),
            lockProbe(REAL_REPO_LOCKED, 11_000),
        ]);
        expect(stale.kind).toBe('stale');
        if (stale.kind !== 'stale') throw new Error('unreachable');
        expect(LOCK_PROBE_PATHS).toContain(stale.lockPath);
        expect(stale.fix).toContain('.git/index.lock');
    });
});

describe('the probe run · a bound that still outlives the stale window', () => {
    it('keeps the probes in the order they were taken, newest last', () => {
        const run = [lockProbe(REAL_REPO, 0), lockProbe(REAL_REPO_LOCKED, 1_000)]
            .reduce<ReturnType<typeof lockProbe>[]>((probes, probe) => recordProbe(probes, probe), []);
        expect(run.map((probe) => probe.at)).toEqual([0, 1_000]);
        expect(run.map((probe) => probe.present)).toEqual([false, true]);
    });

    it('MEASURED: a lock held forever is still reported stale after the run is trimmed', () => {
        // The bound is the trap. `repoLockState` measures the hold from the OLDEST retained
        // sighting, so a run too short to span the stale window would report `held` for a lock
        // that had been stuck for an hour — the surface would go quiet exactly when it matters.
        let run: ReturnType<typeof lockProbe>[] = [];
        for (let i = 0; i < 200; i++) run = recordProbe(run, lockProbe(REAL_REPO_LOCKED, i * 5_000));
        expect(run.length).toBeLessThanOrEqual(PROBE_KEEP);
        expect(repoLockState(run).kind).toBe('stale');

        // POSITIVE CONTROL: the identical loop with a run too short to span the window reports
        // `held` — so the assertion above is the bound being adequate, not staleness being
        // unconditional.
        let short: ReturnType<typeof lockProbe>[] = [];
        for (let i = 0; i < 200; i++) short = recordProbe(short, lockProbe(REAL_REPO_LOCKED, i * 5_000), 2);
        expect(repoLockState(short).kind).toBe('held');
    });
});

describe('the conflict scan · which tabs Genie can actually compare', () => {
    const disk = (entries: Record<string, string | null>) => new Map(Object.entries(entries));

    it('hands the three texts over and finds the collision through them', () => {
        const assembled = openTabsForScan(
            [panelTab({ path: 'a.ts', content: rewrite(2, 'MINE'), dirty: true })],
            disk({ 'a.ts': rewrite(2, 'THEIRS') }),
        );
        expect(assembled.opaque).toBe(0);
        const scan = scanConflicts({ tabs: assembled.tabs, changes: [change('a.ts', 'atlas')] });
        expect(scan.conflicts).toHaveLength(1);
        expect(scan.conflicts[0]!.lines).toEqual([{ start: 2, end: 3 }]);
        expect(scan.conflicts[0]!.who).toBe('atlas');
    });

    it('COUNTS a dirty tab whose buffer it cannot read rather than passing it off as clean', () => {
        // A plugin tab's editor model lives inside the plugin, so there is no text here to
        // compare — `agent-changes-view.ts`'s refusal to estimate, applied to a buffer.
        const plugin = openTabsForScan(
            [panelTab({ path: 'sheet.xlsx', dirty: true, kind: 'plugin', baseline: undefined, content: '' })],
            disk({ 'sheet.xlsx': 'whatever' }),
        );
        expect(plugin.tabs).toHaveLength(0);
        expect(plugin.opaque).toBe(1);

        // A dirty TEXT tab with no baseline is equally opaque: no common ancestor, so there is
        // nothing the two edits can both be expressed against.
        expect(openTabsForScan(
            [panelTab({ path: 'a.ts', dirty: true, baseline: undefined, content: 'typed' })],
            disk({ 'a.ts': BASE }),
        ).opaque).toBe(1);

        // POSITIVE CONTROL: the same tab as readable text is compared, and nothing is opaque.
        const readable = openTabsForScan(
            [panelTab({ path: 'a.ts', dirty: true, content: rewrite(2, 'MINE') })],
            disk({ 'a.ts': rewrite(2, 'THEIRS') }),
        );
        expect(readable.tabs).toHaveLength(1);
        expect(readable.opaque).toBe(0);
    });

    it('leaves a CLEAN tab out of the count — a plugin tab with nothing to lose is not a gap', () => {
        const clean = openTabsForScan(
            [
                panelTab({ path: 'sheet.xlsx', kind: 'plugin', baseline: undefined, content: '' }),
                panelTab({ path: 'a.ts' }),
            ],
            disk({}),
        );
        expect(clean.opaque).toBe(0);
        // POSITIVE CONTROL: the same plugin tab DIRTY is a gap, so the zero above is the clean
        // rule and not a counter that never increments.
        expect(openTabsForScan(
            [panelTab({ path: 'sheet.xlsx', dirty: true, kind: 'plugin', baseline: undefined, content: '' })],
            disk({}),
        ).opaque).toBe(1);
    });

    it('turns a disk text it has not got into "cannot see", never into "unchanged"', () => {
        // Two different silences — the read failed (`null`) and the read never happened
        // (missing) — and the same honest answer: `scanConflicts` counts the tab as unreadable
        // instead of comparing the buffer against a text nobody has.
        const failed = openTabsForScan(
            [panelTab({ path: 'a.ts', content: rewrite(2, 'MINE'), dirty: true })],
            disk({ 'a.ts': null }),
        );
        const missing = openTabsForScan(
            [panelTab({ path: 'a.ts', content: rewrite(2, 'MINE'), dirty: true })],
            disk({}),
        );
        for (const assembled of [failed, missing]) {
            expect(assembled.tabs[0]!.disk).toBeNull();
            expect(scanConflicts({ tabs: assembled.tabs, changes: [] }).unreadable).toBe(1);
        }
        // POSITIVE CONTROL: with the text present the same tab is read and compared.
        expect(scanConflicts({
            tabs: openTabsForScan(
                [panelTab({ path: 'a.ts', content: rewrite(2, 'MINE'), dirty: true })],
                disk({ 'a.ts': BASE }),
            ).tabs,
            changes: [],
        }).unreadable).toBe(0);
    });
});

describe('the conflict notice · what it says on the file', () => {
    const scanOf = (who: string | null) => scanConflicts({
        tabs: [{ path: 'a.ts', baseline: BASE, buffer: rewrite(2, 'MINE'), disk: rewrite(2, 'THEIRS') }],
        changes: who === null ? [] : [change('a.ts', who)],
    });

    it('numbers lines the way the editor does — 1-based, and a seam as a position', () => {
        // Every range in `FileConflict.lines` is 0-based and half-open, because that is what a
        // diff produces. A human reads the gutter, which starts at 1, so a notice printed in
        // diff coordinates points one line above the collision.
        expect(conflictLines([{ start: 2, end: 3 }])).toBe('line 3');
        expect(conflictLines([{ start: 2, end: 5 }])).toBe('lines 3–5');
        // An insertion seam is a POSITION, not a span — `lines 6–6` would name a line neither
        // side wrote.
        expect(conflictLines([{ start: 5, end: 5 }])).toBe('before line 6');
        expect(conflictLines([{ start: 0, end: 1 }, { start: 7, end: 9 }])).toBe('line 1, lines 8–9');
    });

    it('TITLES the banner with BOTH measurements — the writer’s lines and yours', () => {
        // The mockup's sentence, and every part of it is measured: who, their colliding hunk,
        // and the human's own edit. `theirLines` and `lines` are different ranges, and one
        // printed for both would tell the user the agent touched exactly the line they did.
        const wide = scanConflicts({
            tabs: [{ path: 'a.ts', baseline: BASE, buffer: rewrite(3, 'MINE'), disk: rewriteBlock(2, 5) }],
            changes: [change('a.ts', 'atlas')],
        });
        expect(conflictTitle(wide.conflicts[0]!))
            .toBe('atlas changed lines 3–5 while you had unsaved edits to line 4');
    });

    it('names NOBODY in the title when the write is unclaimed', () => {
        const title = conflictTitle(scanOf(null).conflicts[0]!);
        expect(title).toContain('line 3');
        // No name invented, and no name implied: the file is contested by somebody Genie
        // cannot identify, which is a different sentence from "an agent is editing it".
        expect(title).not.toContain('atlas');
        expect(title).toContain('no agent reported');
        // POSITIVE CONTROL: the claimed collision does name its writer.
        expect(conflictTitle(scanOf('atlas').conflicts[0]!)).toContain('atlas');
    });

    it('says the draft is safe always, and claims the PAUSE only once it happened', () => {
        const conflict = scanOf('atlas').conflicts[0]!;
        for (const state of ['asking', 'paused', 'unreachable', 'unclaimed'] as const) {
            // The half of §5.3's sentence that is true whatever the agent does. A notice that
            // reported only the collision reads as data loss.
            expect(conflictBody(conflict, state)).toContain('nothing is lost');
        }
        // The mockup's claim, made ONLY when `cancel` was honoured.
        expect(conflictBody(conflict, 'paused')).toContain('is paused on it');
        // And never otherwise — an agent still running while the banner says it stopped is
        // the one failure here that costs somebody their code.
        expect(conflictBody(conflict, 'asking')).not.toContain('is paused on it');
        expect(conflictBody(conflict, 'unreachable')).not.toContain('is paused on it');
        expect(conflictBody(conflict, 'unreachable')).toContain('cannot reach');
        // Nobody to pause is its own sentence, not a failure to reach somebody.
        expect(conflictBody(conflict, 'unclaimed')).not.toContain('cannot reach');
        expect(conflictBody(conflict, 'unclaimed')).toContain('nobody to pause');
    });

    it('resolves the pause state from what conflictPauses could actually ask', () => {
        const claimed = scanOf('atlas');
        const live = conflictPauses(claimed, [session('id-atlas', 'atlas', 'spec-1')]);
        const dormant = conflictPauses(claimed, [session('id-atlas', 'atlas', null)]);

        // Asked and honoured.
        expect(conflictPauseState(claimed.conflicts[0]!, live, new Set(['a.ts']))).toBe('paused');
        // Askable, not yet honoured — the request is in flight and the banner must not claim
        // more than that.
        expect(conflictPauseState(claimed.conflicts[0]!, live, new Set())).toBe('asking');
        // No terminal to ask through: never 'paused', whatever the honoured set says, because
        // no request was ever sent.
        expect(conflictPauseState(claimed.conflicts[0]!, dormant, new Set(['a.ts']))).toBe('unreachable');
        // Nobody claimed the write.
        expect(conflictPauseState(scanOf(null).conflicts[0]!, conflictPauses(scanOf(null), []), new Set()))
            .toBe('unclaimed');
    });

    it('stays silent on a CLEAN scan, and speaks up when the scan was PARTIAL', () => {
        const clean = scanConflicts({ tabs: [], changes: [] });
        expect(uncheckedNotice(clean, 0)).toBeNull();

        // A scan that could not look at every tab must not be reported as all-clear: silence
        // here is the reassuring answer arriving by default, which is the whole failure mode
        // `file-panel-states.ts` was written against.
        const partial = uncheckedNotice(clean, 2);
        expect(partial).not.toBeNull();
        expect(partial).toContain('2');

        // And the counts are COUNTS: a scan with one unreadable tab and one opaque tab says 2.
        const unreadable = scanConflicts({
            tabs: [{ path: 'b.ts', baseline: BASE, buffer: rewrite(1, 'MINE'), disk: null }],
            changes: [],
        });
        expect(unreadable.unreadable).toBe(1);
        expect(uncheckedNotice(unreadable, 1)).toContain('2');
    });
});

describe('the tree’s change marker', () => {
    it('uses git’s OWN letter and the board’s colour for each state', () => {
        expect(changeMarker('modified')).toEqual({ letter: 'M', tone: 'amber' });
        expect(changeMarker('added')).toEqual({ letter: 'A', tone: 'emerald' });
        expect(changeMarker('deleted')).toEqual({ letter: 'D', tone: 'red' });
        // The three the mockup does not name keep git's letters rather than being forced into
        // one of the three above: a renamed file is not a modified one, and `U` is what git
        // calls untracked.
        expect(changeMarker('untracked')).toEqual({ letter: 'U', tone: 'emerald' });
        expect(changeMarker('renamed')).toEqual({ letter: 'R', tone: 'amber' });
    });

    it('marks NOTHING for a file git said nothing about, or said to ignore', () => {
        // `null` is "git reported no status for this path", and a marker would be a state
        // claim. An ignored file is not news either — same rule as `changedFilePaths`.
        expect(changeMarker(null)).toBeNull();
        expect(changeMarker('ignored')).toBeNull();
        // POSITIVE CONTROL: the same function marks a real status, so the two nulls are the
        // rule and not a mapper that never resolves.
        expect(changeMarker('modified')).not.toBeNull();
    });
});

describe('the changes list · attribution the rule earned', () => {
    const rowsBy = (
        changes: SessionFileChange[],
        gitStatus: GitStatusMap = {},
        conflicts: string[] | null = null,
    ) => new Map(changeRows(changes, gitStatus, conflicts).map((row) => [row.path, row]));

    it('labels an unreported write "?" in neutral grey, and names the one that was reported', () => {
        const rows = rowsBy(
            [change('mine.ts', 'atlas', 2_000), change('theirs.ts', null, 3_000)],
            { 'mine.ts': 'modified', 'theirs.ts': 'modified' },
        );
        expect(rows.get('theirs.ts')).toMatchObject({ who: null, label: '?', tone: 'neutral', at: 3_000 });
        // POSITIVE CONTROL: the claimed file in the same list keeps its author and git's own
        // colour, so the grey above is a statement about attribution.
        expect(rows.get('mine.ts')).toMatchObject({ who: 'atlas', label: 'atlas', tone: 'status', at: 2_000 });
    });

    it('includes a file GIT reports that no agent ever mentioned', () => {
        // The case §5.3 names outright, and the one the old inline list could not show at all:
        // it iterated the reported changes, so a file changed before Genie was watching was
        // absent rather than unattributed.
        const rows = rowsBy([], { 'stranger.ts': 'modified' });
        expect(rows.get('stranger.ts')).toMatchObject({ who: null, label: '?', tone: 'neutral' });
        // With no reported write there is no timestamp, and `0` is how the row says so — the
        // panel renders nothing for a falsy stamp rather than a date from the epoch.
        expect(rows.get('stranger.ts')!.at).toBe(0);
        // An IGNORED file nobody claimed is still not news (inherited from `changedFilePaths`).
        expect(rowsBy([], { 'node_modules/x.js': 'ignored' }).size).toBe(0);
    });

    it('KEEPS the order it is handed and appends the git-only files, newest write first', () => {
        // `sessionFileChanges` already sorted these newest-first, and re-sorting here would be
        // a second opinion about the same timestamps. What this asserts is that the order
        // SURVIVES — and that a git-only file does not jump the queue by name: `aaa.ts` sorts
        // first alphabetically and still lands last, because it has no reported write at all.
        const rows = changeRows(
            [change('new.ts', 'atlas', 9_000), change('old.ts', 'atlas', 1_000)],
            { 'aaa.ts': 'modified' },
            null,
        );
        expect(rows.map((row) => row.path)).toEqual(['new.ts', 'old.ts', 'aaa.ts']);
    });

    it('keeps "no conflict" and "nobody scanned" apart on every row', () => {
        const changes = [change('a.ts', 'atlas'), change('b.ts', 'atlas')];
        // Nobody scanned: the row makes NO claim either way. `false` here would tell the user
        // their unsaved edit is safe on the strength of a scan that never ran.
        expect(changeRows(changes, {}, null).map((row) => row.conflict)).toEqual([null, null]);
        // Somebody scanned and found none — a measurement, and a different answer.
        expect(changeRows(changes, {}, []).map((row) => row.conflict)).toEqual([false, false]);
        // And a scan that found one marks THAT file, counted rather than asserted per row.
        const found = changeRows(changes, {}, ['a.ts']);
        expect(found.filter((row) => row.conflict === true).map((row) => row.path)).toEqual(['a.ts']);
        expect(found.filter((row) => row.conflict === false)).toHaveLength(1);
    });
});
