import { describe, expect, it } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
    ChangeMarker,
    ConflictBanner,
    FilePanelStandIn,
    FilesHeader,
    PanelChangesList,
    RepoChip,
    UnattributedBanner,
    UncheckedNotice,
    WhoChip,
} from '../Code/FilePanelStates';
import {
    conflictPauses,
    diskWriteMarks,
    filePanelSlot,
    repoLockState,
    scanConflicts,
    singlePoppedPanel,
    type ConflictScan,
    type OpenTab,
} from '../../lib/file-panel-states';
import { changeRows, type ChangeRow } from '../../lib/file-panel-signals';
import { emptyAgentSession, type AgentSession } from '../../../main/agentsession/model';

/**
 * THAT §5.3's PANEL STATES REACH A SCREEN, in the shape the mockup specifies.
 *
 * `file-panel-states.ts` was correct, tested, and called by NOTHING — which is the defect this
 * release exists to fix, because a distinction computed and then dropped on the floor is
 * indistinguishable from one never computed. The rules are not re-tested here; these assert
 * that the render CARRIES them, and in particular that the three "cannot see" states still
 * read as "cannot see" after passing through a component.
 *
 * The scans and states are built by calling the real rules rather than hand-written literals,
 * so a failure here cannot be a fixture that drifted from them.
 */

const BASE = ['l0', 'l1', 'l2', 'l3', 'l4', 'l5', 'l6', 'l7', 'l8', 'l9'].join('\n');

const rewrite = (n: number, text: string): string =>
    BASE.split('\n').map((line, index) => (index === n ? text : line)).join('\n');

const tab = (over: Partial<OpenTab> & { path: string }): OpenTab =>
    ({ baseline: BASE, buffer: BASE, disk: BASE, ...over });

/** A real collision on line 3 of `a.ts`, claimed by `who` (null ⇒ nobody reported it). */
function collision(who: string | null, path = 'a.ts'): ConflictScan {
    return scanConflicts({
        tabs: [tab({ path, buffer: rewrite(2, 'MINE'), disk: rewrite(2, 'THEIRS') })],
        changes: who === null ? [] : [{ path, who, agentId: `id-${who}`, at: 1_000 }],
    });
}

function session(agentId: string, name: string, specId: string | null): AgentSession {
    return emptyAgentSession({ agentId, specId, provider: 'claude', name, cwd: 'C:/ws', workspaceId: 'w' }, 0);
}

const count = (html: string, needle: string): number => html.split(needle).length - 1;

const banner = (props: {
    scan: ConflictScan | null;
    sessions?: AgentSession[];
    honoured?: string[];
}): string =>
    renderToStaticMarkup(
        React.createElement(ConflictBanner, {
            scan: props.scan,
            pauses: props.scan ? conflictPauses(props.scan, props.sessions ?? []) : null,
            honoured: new Set(props.honoured ?? []),
            onCompare: () => {},
            onKeepMine: () => {},
            onTakeTheirs: () => {},
        }),
    );

describe('the conflict banner', () => {
    it('is the mockup’s sentence, with every part of it measured', () => {
        const html = banner({
            scan: collision('atlas'),
            sessions: [session('id-atlas', 'atlas', 'spec-1')],
            honoured: ['a.ts'],
        });
        expect(count(html, 'code-conflict-file')).toBe(1);
        expect(html).toContain('a.ts');
        // 1-based, because the gutter beside it is. `line 2` would point at the wrong line.
        expect(html).toContain('atlas changed line 3 while you had unsaved edits to line 3');
        expect(html).toContain('Your version is kept as a draft and nothing is lost.');
        expect(html).toContain('atlas has been told the file is in conflict and is paused on it.');
    });

    it('offers Compare, Keep mine and Take theirs — named for the agent', () => {
        const html = banner({ scan: collision('atlas'), sessions: [session('id-atlas', 'atlas', 'spec-1')] });
        expect(count(html, 'code-conflict-action')).toBe(3);
        expect(html).toContain('Compare');
        expect(html).toContain('Keep mine');
        expect(html).toContain("Take atlas&#x27;s");
        // An unclaimed write has no name to put on the button, and Genie does not invent one.
        const unclaimed = banner({ scan: collision(null) });
        expect(unclaimed).toContain('Take the version on disk');
        expect(unclaimed).not.toContain('atlas');
    });

    it('NEVER says the agent stopped unless the cancel was honoured', () => {
        const live = [session('id-atlas', 'atlas', 'spec-1')];
        // Asked, not yet honoured.
        const asking = banner({ scan: collision('atlas'), sessions: live });
        expect(asking).toContain('Genie is asking atlas to stop');
        expect(asking).not.toContain('is paused on it');

        // A DORMANT agent has no terminal to ask through, so nothing was even sent. §5.3's
        // "the agent pauses" is then not true and the banner says so.
        const dormant = banner({ scan: collision('atlas'), sessions: [session('id-atlas', 'atlas', null)] });
        expect(dormant).toContain('cannot reach atlas');
        expect(dormant).not.toContain('is paused on it');

        // POSITIVE CONTROL: the honoured case DOES claim it, so the two refusals above are the
        // state and not a sentence the component never renders.
        expect(banner({ scan: collision('atlas'), sessions: live, honoured: ['a.ts'] }))
            .toContain('is paused on it');
    });

    it('says NOTHING when there is nothing to say', () => {
        // Nobody has scanned yet: no banner, and no all-clear either.
        expect(banner({ scan: null })).toBe('');
        // Scanned and clear: still nothing, because a clear panel is the normal state.
        expect(banner({ scan: scanConflicts({ tabs: [], changes: [] }) })).toBe('');
        // POSITIVE CONTROL: a real collision renders.
        expect(banner({ scan: collision('atlas') })).not.toBe('');
    });
});

describe('the unchecked-scan notice', () => {
    const notice = (scan: ConflictScan, opaque: number) =>
        renderToStaticMarkup(React.createElement(UncheckedNotice, { scan, opaque }));
    const clean = scanConflicts({ tabs: [], changes: [] });

    it('speaks up for a PARTIAL scan, with a COUNT', () => {
        const partial = notice(clean, 2);
        expect(partial).toContain('2');
        expect(count(partial, 'code-unchecked')).toBe(1);
    });

    it('is silent when the scan looked at everything', () => {
        // A scan that read every tab has nothing to disclaim. Silence here is earned, unlike
        // the silence above it would otherwise be mistaken for.
        expect(notice(clean, 0)).toBe('');
        // POSITIVE CONTROL: one unchecked tab breaks the silence.
        expect(notice(clean, 1)).not.toBe('');
    });
});

describe('the repo chip', () => {
    const chip = (probes: Array<{ at: number; present: boolean | null }>, onRemove?: () => void) =>
        renderToStaticMarkup(
            React.createElement(RepoChip, { name: 'web', state: repoLockState(probes), onRemoveLock: onRemove }),
        );
    const STALE = [{ at: 0, present: true }, { at: 11_000, present: true }];

    it('carries the stale lock itself, and offers to remove it', () => {
        const html = chip(STALE, () => {});
        expect(html).toContain('index.lock held');
        expect(count(html, 'code-repo-chip is-locked')).toBe(1);
        expect(count(html, 'code-remove-lock')).toBe(1);
        expect(html).toContain('Remove stale lock');
    });

    it('names the repo and NOTHING ELSE when there is no lock to report', () => {
        const quiet = chip([{ at: 0, present: false }]);
        expect(quiet).toContain('web');
        expect(quiet).not.toContain('index.lock');
        expect(count(quiet, 'is-locked')).toBe(0);
        // The remove button is for a PROVEN stale lock only.
        expect(count(quiet, 'code-remove-lock')).toBe(0);
    });

    it('draws NEITHER for a lock it cannot see, while still naming the repo', () => {
        // `unseen` is the trap: a chip that said "no lock" here would report a clean repo it
        // never managed to read, and a Remove button would offer to delete a file nobody
        // looked for. The repo's name is still a fact, so it stays.
        const blind = chip([], () => {});
        expect(blind).toContain('web');
        expect(count(blind, 'is-locked')).toBe(0);
        expect(count(blind, 'code-remove-lock')).toBe(0);
        // A lock git is actively holding is not news either; it clears in milliseconds.
        expect(count(chip([{ at: 0, present: true }], () => {}), 'code-remove-lock')).toBe(0);
        // POSITIVE CONTROL: the stale case does draw both.
        expect(count(chip(STALE, () => {}), 'code-remove-lock')).toBe(1);
    });
});

describe('the unattributed-write banner', () => {
    const blind = (at: number, onShowDiff?: () => void) =>
        renderToStaticMarkup(
            React.createElement(UnattributedBanner, { path: 'a.ts', at, onShowDiff }),
        );

    it('says Genie does not guess, and is NOT an error', () => {
        const html = blind(0);
        expect(html).toContain('No agent reported this change');
        expect(html).toContain('Genie does not guess the author');
        expect(count(html, 'code-unattributed-title')).toBe(1);
        // Not red: an unexplained write is a thing Genie cannot see, not a thing that went
        // wrong. The conflict banner is the red one.
        expect(html).not.toContain('border-red-500');
    });

    it('names the time the WATCHER saw, and omits it when there is none', () => {
        // A git-only change has no reported write and so no timestamp. `0` must render as
        // nothing rather than a time from the epoch.
        expect(blind(0)).not.toContain('The file watcher saw a write at');
        // POSITIVE CONTROL: a stamped write names the time.
        expect(blind(1_000_000)).toContain('The file watcher saw a write at');
    });
});

describe('the changes list', () => {
    const list = (rows: ChangeRow[]) =>
        renderToStaticMarkup(React.createElement(PanelChangesList, { rows, onOpen: () => {} }));

    it('reads "on disk · not attributed" for a write nobody reported', () => {
        const rows = changeRows(
            [
                { path: 'mine.ts', who: 'atlas', agentId: 'id-atlas', at: 2_000 },
                { path: 'theirs.ts', who: null, agentId: null, at: 3_000 },
            ],
            {},
            [],
        );
        const html = list(rows);
        expect(count(html, 'code-session-change')).toBe(2);
        expect(html).toContain('on disk · not attributed');
        expect(count(html, 'is-unattributed')).toBe(1);
        // POSITIVE CONTROL: the claimed row in the same list carries its author and is NOT
        // greyed, so the single neutral row above is attribution rather than a flat repaint.
        expect(html).toContain('atlas');
        expect(count(html, 'is-attributed')).toBe(1);
    });

    it('renders a time only for a write that HAS one', () => {
        const gitOnly = changeRows([], { 'stranger.ts': 'modified' }, []);
        expect(gitOnly[0]!.at).toBe(0);
        expect(count(list(gitOnly), '<time')).toBe(0);
        // POSITIVE CONTROL: a stamped row renders exactly one.
        const stamped = changeRows([{ path: 'a.ts', who: 'atlas', agentId: 'id', at: 5_000 }], {}, []);
        expect(count(list(stamped), '<time')).toBe(1);
    });

    it('marks a CONTESTED file and no other', () => {
        const changes = [
            { path: 'a.ts', who: 'atlas', agentId: 'id-atlas', at: 2_000 },
            { path: 'b.ts', who: 'atlas', agentId: 'id-atlas', at: 1_000 },
        ];
        // One conflict out of two files: a COUNT, so a mark on every row or on none would fail.
        expect(count(list(changeRows(changes, {}, ['a.ts'])), 'is-conflict')).toBe(1);
        // Scanned and clear: no marks — a measurement.
        expect(count(list(changeRows(changes, {}, [])), 'is-conflict')).toBe(0);
    });

    it('makes NO claim about a scan that did not happen — the notice carries that, not a row', () => {
        // `[]` (looked, found none) and `null` (nobody looked) render IDENTICALLY here, and
        // this asserts that identity rather than pretending the rows discriminate. A mark means
        // "contested" and its absence means nothing at all; putting a per-row "checked" state on
        // screen would badge every file in the panel to answer a question about the SCAN.
        const changes = [{ path: 'a.ts', who: 'atlas', agentId: 'id-atlas', at: 2_000 }];
        expect(list(changeRows(changes, {}, null))).toBe(list(changeRows(changes, {}, [])));
        // POSITIVE CONTROL: a contested scan of the same file renders DIFFERENTLY.
        expect(list(changeRows(changes, {}, ['a.ts']))).not.toBe(list(changeRows(changes, {}, [])));
    });
});

describe('the tree’s who chip and change marker', () => {
    const who = (mark: ReturnType<typeof diskWriteMarks>[number], live = false) =>
        renderToStaticMarkup(React.createElement(WhoChip, { mark, live }));
    const marks = (changes: Parameters<typeof diskWriteMarks>[0]) => diskWriteMarks(changes, {});

    it('is VIOLET for an agent and neutral grey for a "?"', () => {
        const [mine, theirs] = marks([
            { path: 'mine.ts', who: 'atlas', agentId: 'id-atlas', at: 1 },
            { path: 'theirs.ts', who: null, agentId: null, at: 2 },
        ]).sort((a, b) => a.path.localeCompare(b.path));

        const attributed = who(mine!);
        expect(attributed).toContain('atlas');
        expect(attributed).toContain('violet');

        // The board's rule: "It shows in neutral grey with a '?'. Genie does not guess the
        // author." Violet means a named agent, so an unclaimed write must not wear it.
        const unattributed = who(theirs!);
        expect(unattributed).toContain('?');
        expect(unattributed).not.toContain('violet');
        expect(count(unattributed, 'is-unattributed')).toBe(1);
    });

    it('pulses ONLY while the write is in flight', () => {
        const [mine] = marks([{ path: 'mine.ts', who: 'atlas', agentId: 'id-atlas', at: 1 }]);
        expect(count(who(mine!, true), 'is-live')).toBe(1);
        // A finished write does not pulse — a live mark that outlives the write makes a quiet
        // workspace look busy.
        expect(count(who(mine!, false), 'is-live')).toBe(0);
    });

    it('marks M amber, A emerald, D red — and nothing for a file git did not report', () => {
        const marker = (status: Parameters<typeof ChangeMarker>[0]['status']) =>
            renderToStaticMarkup(React.createElement(ChangeMarker, { status }));
        expect(marker('modified')).toContain('>M<');
        expect(marker('modified')).toContain('amber');
        expect(marker('added')).toContain('>A<');
        expect(marker('added')).toContain('emerald');
        expect(marker('deleted')).toContain('>D<');
        expect(marker('deleted')).toContain('red');
        // A marker is a state claim, and git made none.
        expect(marker(null)).toBe('');
        expect(marker('ignored')).toBe('');
    });
});

describe('the panel header', () => {
    const header = (changedCount: number, filter = 'all') =>
        renderToStaticMarkup(
            React.createElement(FilesHeader, {
                filter,
                onFilterChange: () => {},
                changedCount,
                onPopOut: () => {},
                onClose: () => {},
            }),
        );

    it('is Files, a segmented All | Changed N, the one-per-workspace hint and two icon buttons', () => {
        const html = header(4);
        expect(html).toContain('Files');
        expect(html).toContain('Changed 4');
        expect(html).toContain('one per workspace');
        expect(count(html, 'code-head-popout')).toBe(1);
        expect(count(html, 'code-head-close')).toBe(1);
        // The chord is on the close control, so the panel teaches its own keyboard.
        expect(html).toContain('B');
    });

    it('shows the COUNT it is given, including zero', () => {
        // Zero changed files is a measurement and reads differently from a panel that has not
        // looked — which is the tree's job to say, not this label's.
        expect(header(0)).toContain('Changed 0');
        expect(header(12)).toContain('Changed 12');
    });
});

describe('the slot a popped-out panel leaves behind', () => {
    const standIn = (
        input: { popped: boolean; owned: boolean | null; closed: boolean; local: boolean },
        panels: Array<{ workspaceId: string; specId: string }> = [],
    ) =>
        renderToStaticMarkup(
            React.createElement(FilePanelStandIn, {
                slot: filePanelSlot(input),
                duplicates: singlePoppedPanel(panels, 'w').duplicates,
                workspaceName: 'tynn',
                onFocusWindow: () => {},
                onBringBack: () => {},
                onClose: () => {},
            }),
        );

    const OPEN = { popped: false, owned: true, closed: false, local: true };

    it('is the mockup’s bar: the sentence, the route, Focus window and Bring back', () => {
        const popped = standIn({ ...OPEN, popped: true, owned: false });
        expect(count(popped, 'code-popped-bar')).toBe(1);
        expect(popped).toContain('tynn files are open in their own window.');
        expect(popped).toContain('genie://workspace/tynn/files?window=detached');
        expect(popped).toContain('Focus window');
        expect(popped).toContain('Bring back');
    });

    it('offers BRING BACK only for the panel this workspace popped', () => {
        // Another window holds the panel and this workspace did not send it there. There is a
        // window to FOCUS and nothing here to reel in — offering the button anyway would move
        // somebody else's panel out from under them.
        const elsewhere = standIn({ ...OPEN, owned: false });
        expect(elsewhere).toContain('Focus window');
        expect(elsewhere).not.toContain('Bring back');
        expect(count(elsewhere, 'code-popped-bar')).toBe(0);
        // POSITIVE CONTROL: the popped panel has both.
        expect(standIn({ ...OPEN, popped: true, owned: false })).toContain('Bring back');
    });

    it('a CLOSED panel looks the same, without the bar', () => {
        const closed = standIn({ ...OPEN, closed: true });
        expect(closed).not.toContain('Bring back');
        expect(closed).not.toContain('Focus window');
        expect(count(closed, 'code-popped-bar')).toBe(0);
        // ⌘B on a POPPED panel is still the quiet state and still no bar.
        expect(count(standIn({ ...OPEN, popped: true, closed: true }), 'code-popped-bar')).toBe(0);
    });

    it('claims nothing while the claim is still in flight', () => {
        const opening = standIn({ ...OPEN, owned: null });
        expect(opening).toContain('Opening');
        expect(opening).not.toContain('Focus window');
    });

    it('renders NOTHING when the panel itself belongs here', () => {
        expect(standIn(OPEN)).toBe('');
        expect(standIn({ ...OPEN, local: false, owned: null })).toBe('');
    });

    it('COUNTS a duplicate popped window instead of quietly taking the first', () => {
        const two = [
            { workspaceId: 'w', specId: 'first' },
            { workspaceId: 'w', specId: 'second' },
        ];
        const html = standIn({ ...OPEN, popped: true, owned: false }, two);
        expect(html).toContain('1');
        expect(count(html, 'code-popped-duplicate')).toBe(1);
        // POSITIVE CONTROL: one window reports no extras at all.
        expect(count(standIn({ ...OPEN, popped: true, owned: false }, [two[0]!]), 'code-popped-duplicate'))
            .toBe(0);
    });
});
