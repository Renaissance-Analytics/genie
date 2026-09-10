import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { upgradeModalPlan } from '../drain-roster';
import type { DrainRow, DrainSnapshot } from '../../../main/agents/drain';

/**
 * THE UPGRADE MODAL (genie#565).
 *
 * The owner's ask: *"When an upgrade is in progress, I should see a big wide
 * modal with a blurry backdrop that shows me what is in this upgrade on the
 * left side and the agent shutdown list on the right that shows all agents
 * status in a clean list"*
 *
 * WHEN it is on screen is the part that can be got wrong invisibly, so it is
 * decided here rather than inside the component. "While the upgrade is in
 * progress" means once the DRAIN has started — not at download time, which is
 * not something a person needs to watch agents for.
 *
 * The three states of a snapshot are not obvious from its shape and the
 * difference matters: `active` is holding, `complete` is the last beat before
 * the restart, and rows-but-neither is a drain the user CANCELLED — which must
 * take the modal away rather than leave it up over an upgrade that is no longer
 * happening.
 */

const row = (over: Partial<DrainRow> = {}): DrainRow => ({
    agentId: 'a1',
    inboxAgentId: 'i1',
    terminalId: 't1',
    name: 'claude',
    workspaceId: 'w',
    state: 'waiting',
    satisfiedBy: null,
    note: null,
    ...over,
});

const snap = (over: Partial<DrainSnapshot> = {}): DrainSnapshot => ({
    active: true,
    startedAt: 0,
    rows: [row()],
    complete: false,
    ...over,
});

/**
 * WITH NO INTENT FROM THE USER (`auto`), the drain still puts the gate on
 * screen by itself — genie#565's whole point, and unchanged by genie#622.
 */
describe('when the modal is on screen', () => {
    it('opens once the drain is holding the upgrade', () => {
        expect(upgradeModalPlan({ drain: snap(), latestVersion: '0.7.0-beta.311' })).toEqual({
            open: true,
            version: '0.7.0-beta.311',
            roster: true,
        });
    });

    it('stays up for the last beat, so the final roster is the one you see', () => {
        // Every row green, the apply on its way. Closing here would snatch the
        // answer away at the moment it arrives.
        expect(
            upgradeModalPlan({
                drain: snap({ active: false, complete: true, rows: [row({ state: 'ready' })] }),
                latestVersion: '0.7.0-beta.311',
            }).open,
        ).toBe(true);
    });

    it('does not put itself back up after the drain was CANCELLED', () => {
        // Rows, but neither running nor complete. The upgrade was abandoned, so
        // nothing reopens the sheet on its own — but the user can (genie#622,
        // below), which is the difference this file is now asserting.
        expect(
            upgradeModalPlan({
                drain: snap({ active: false, complete: false }),
                latestVersion: '0.7.0-beta.311',
            }).open,
        ).toBe(false);
    });

    it('is not open before any drain has run', () => {
        expect(upgradeModalPlan({ drain: null, latestVersion: '0.7.0-beta.311' }).open).toBe(
            false,
        );
    });

    it('is not open for a DOWNLOAD — that is not something to watch agents for', () => {
        // A drain with no rows is what an upgrade with nothing to ask produces.
        // It resolves immediately, and a modal that flashed up for it would be
        // a full-screen interruption for an upgrade nobody was blocking.
        expect(
            upgradeModalPlan({ drain: snap({ rows: [] }), latestVersion: '0.7.0-beta.311' })
                .open,
        ).toBe(false);
    });

    it('opens without a version rather than not at all', () => {
        // The left pane needs a version to fetch notes for and may not have one
        // yet. The agent list is the half that cannot wait — the user is being
        // asked to decide about their own running work.
        expect(upgradeModalPlan({ drain: snap(), latestVersion: null })).toEqual({
            open: true,
            version: null,
            roster: true,
        });
    });
});

/**
 * THE WINDOW HAS AN OPEN AND A CLOSE OF ITS OWN (genie#622).
 *
 * The owner: *"If I cancel an upgrade I am unable to open the upgrade window
 * again. I should be able to open that window and close it without starting the
 * whole process over again."*
 *
 * Both halves were the same bug. `open` was derived entirely from the drain, so
 * the only control that dismissed the sheet was *Cancel the upgrade* — closing
 * the window WAS cancelling — and cancelling clears the roster, so both halves
 * of the old predicate went false with nothing in the UI able to set them again.
 *
 * So there are now two independent facts, and only the second belongs to the
 * drain:
 *
 *  - **Am I looking at the upgrade?** The user's `intent`. `auto` until they
 *    touch it; `open` from the header control; `closed` when they dismiss it.
 *  - **Is a drain running?** Which decides the ROSTER, and nothing else.
 *
 * `forDrain` is what stops the two from smearing together: a dismissal is about
 * the drain that was on screen when it happened, so a LATER drain — genie#565's
 * gate, the thing that stops an upgrade restarting under working agents — still
 * shows itself.
 */
describe('the window opens and closes on its own (genie#622)', () => {
    it('opens with no drain at all — a preview of what the upgrade contains', () => {
        expect(
            upgradeModalPlan({
                drain: null,
                latestVersion: '0.7.0-beta.311',
                view: { intent: 'open', forDrain: null },
                upgradePending: true,
            }),
        ).toEqual({ open: true, version: '0.7.0-beta.311', roster: false });
    });

    it('opens again after the upgrade was CANCELLED — the whole of genie#622', () => {
        // Rows, neither active nor complete: exactly what cancelUpgradeDrain
        // leaves behind, and the state the owner could not get back into.
        expect(
            upgradeModalPlan({
                drain: snap({ active: false, complete: false }),
                latestVersion: '0.7.0-beta.311',
                view: { intent: 'open', forDrain: null },
                upgradePending: true,
            }).open,
        ).toBe(true);
    });

    it('closing takes the VIEW away and leaves the drain alone', () => {
        const drain = snap();
        const before = structuredClone(drain);
        expect(
            upgradeModalPlan({
                drain,
                latestVersion: '0.7.0-beta.311',
                view: { intent: 'closed', forDrain: drain.startedAt },
                upgradePending: true,
            }).open,
        ).toBe(false);
        // The drain is untouched — the plan is a reader, not a control.
        expect(drain).toEqual(before);
        // And it is still there to come back to: one click on the header
        // control and the same running drain is on screen again.
        expect(
            upgradeModalPlan({
                drain,
                latestVersion: '0.7.0-beta.311',
                view: { intent: 'open', forDrain: null },
                upgradePending: true,
            }),
        ).toEqual({ open: true, version: '0.7.0-beta.311', roster: true });
    });

    it('a NEW drain shows itself even after the last one was dismissed', () => {
        // genie#565's gate. Dismissing one upgrade's window must not silence
        // the next one, or closing it once disarms the guard for good.
        expect(
            upgradeModalPlan({
                drain: snap({ startedAt: 2_000 }),
                latestVersion: '0.7.0-beta.311',
                view: { intent: 'closed', forDrain: 1_000 },
                upgradePending: true,
            }).open,
        ).toBe(true);
    });

    it('shows the ROSTER only while a drain is running', () => {
        const shown = (drain: DrainSnapshot | null): boolean =>
            upgradeModalPlan({
                drain,
                latestVersion: '0.7.0-beta.311',
                view: { intent: 'open', forDrain: null },
                upgradePending: true,
            }).roster;
        expect(shown(null), 'no drain — there is nobody to list').toBe(false);
        expect(shown(snap({ active: false, complete: false })), 'cancelled').toBe(false);
        expect(shown(snap()), 'holding the upgrade').toBe(true);
        expect(
            shown(snap({ active: false, complete: true, rows: [row({ state: 'ready' })] })),
            'the last beat, where the final roster is the one you see',
        ).toBe(true);
    });

    it('will not open over nothing — no drain, and no upgrade on offer', () => {
        // The header control is what opens it, and there is nothing to click
        // when Genie is up to date. A sheet over an empty offer would be a
        // full-screen interruption describing no upgrade at all.
        expect(
            upgradeModalPlan({
                drain: null,
                latestVersion: null,
                view: { intent: 'open', forDrain: null },
                upgradePending: false,
            }).open,
        ).toBe(false);
    });
});

/**
 * PROMOTED, NOT DUPLICATED.
 *
 * `DrainRosterFlyout` was a corner dialog showing exactly this roster. The
 * modal is that list given a pane, so the flyout must be GONE — two surfaces
 * for one drain is the same duplication the header pill and the banner had.
 */
describe('the corner roster was promoted into the modal', () => {
    const master = readFileSync(path.resolve(__dirname, '../../pages/master.tsx'), 'utf8');

    it('reads the file it claims to be checking', () => {
        // The positive control: "X is absent" passes on an empty string too.
        expect(master.length).toBeGreaterThan(10_000);
        expect(master).toContain('drainRosterSummary');
    });

    it('has no separate corner flyout left', () => {
        expect(master).not.toContain('DrainRosterFlyout');
    });

    it('renders the modal exactly once', () => {
        expect(master.match(/<UpgradeModal\b/g) ?? []).toHaveLength(1);
    });

    it('still reuses the roster helpers rather than new status logic', () => {
        // The lead's instruction, made checkable: per-row icon, label and
        // "can this be satisfied" all already exist and are already tested.
        for (const helper of [
            'drainRowIcon',
            'drainRowStatusLabel',
            'canSatisfyDrainRow',
            'drainRosterSummary',
        ]) {
            expect(master, `${helper} is no longer used`).toContain(helper);
        }
    });
});

/**
 * The backdrop and the two panes are structure, not styling preference — the
 * owner asked for them by name. They cannot be seen from this lane, so what is
 * asserted here is that the rules EXIST and say what they must; how it looks is
 * left to the E2E and to a person.
 */
describe('the modal is a blurred-backdrop two-pane sheet', () => {
    const css = readFileSync(path.resolve(__dirname, '../../styles/master.css'), 'utf8');

    it('reads the stylesheet it claims to be checking', () => {
        expect(css.length).toBeGreaterThan(10_000);
    });

    /** One rule's body, sliced to its closing brace. A fixed character window
     *  would go quiet the moment somebody adds a comment above the property. */
    const rule = (selector: string): string => {
        const start = css.indexOf(selector);
        expect(start, `${selector} is not in the stylesheet`).toBeGreaterThan(-1);
        const end = css.indexOf('}', start);
        expect(end).toBeGreaterThan(start);
        return css.slice(start, end);
    };

    it('blurs the backdrop', () => {
        expect(rule('.upgrade-modal-backdrop')).toMatch(/backdrop-filter:\s*blur\(/);
    });

    it('dims it too, so a browser without the filter still separates the layers', () => {
        expect(rule('.upgrade-modal-backdrop')).toMatch(/background:/);
    });

    it('lays the sheet out in two columns, and is wide', () => {
        const sheet = rule('.upgrade-modal {');
        expect(sheet).toMatch(/grid-template-columns/);
        expect(sheet).toMatch(/width|max-width/);
    });
});

/**
 * THE MODAL HAS TO ACTUALLY BE ON TOP.
 *
 * master.css documents the trap in its own words: a rung number *"only
 * outranks the Fancy layer while every ancestor of the thing carrying it is
 * stacking-context-free — one `transform` / `filter` / `contain` on an ancestor
 * traps the subtree and the number quietly stops meaning anything."* genie#114
 * was that failure: the file picker painted see-through over the modal that
 * opened it, and the earlier z-index fix did not settle it.
 *
 * So a full-screen sheet cannot be rendered in place inside the page. It
 * portals into the overlay root, which `ensureOverlayRoot` keeps as a direct
 * child of `<body>` and which carries the token scope so `var(--card)` resolves
 * to a real surface instead of transparent.
 */
describe('the modal is on the top layer, not just numbered high', () => {
    const master = readFileSync(path.resolve(__dirname, '../../pages/master.tsx'), 'utf8');
    const css = readFileSync(path.resolve(__dirname, '../../styles/master.css'), 'utf8');
    const modal = master.slice(
        master.indexOf('function UpgradeModal('),
        master.indexOf('function UpdatePopover('),
    );

    it('reads the component it claims to be checking', () => {
        expect(modal.length).toBeGreaterThan(500);
        expect(modal).toContain('upgrade-modal-backdrop');
    });

    it('portals into the overlay root rather than rendering in place', () => {
        expect(modal).toContain('ensureOverlayRoot');
        expect(modal).toContain('createPortal');
    });

    it('sits above every dialog rung the stylesheet defines', () => {
        // Not a magic number: read the rungs the file itself declares and
        // require the modal to outrank them. If someone raises the picker, this
        // fails rather than letting the sheet silently slip underneath.
        const rung = (re: RegExp): number => {
            const m = css.match(re);
            expect(m, `no rung matched ${re}`).toBeTruthy();
            return Number(m![1]);
        };
        const fancy = rung(/--z-fancy-overlay:\s*(\d+)/);
        const picker = rung(/--z-picker:\s*(\d+)/);
        const whatsNew = rung(/\.whats-new-backdrop\s*\{[^}]*?z-index:\s*(\d+)/s);

        const backdrop = css.slice(css.indexOf('.upgrade-modal-backdrop'), css.indexOf('.upgrade-modal {'));
        const mine = Number(backdrop.match(/z-index:\s*(\d+)/)?.[1]);
        expect(Number.isFinite(mine)).toBe(true);

        for (const [name, below] of [
            ['the Fancy overlay layer', fancy],
            ['the picker layer', picker],
            ["What's New", whatsNew],
        ] as const) {
            expect(mine, `the upgrade modal must outrank ${name}`).toBeGreaterThan(below);
        }
    });

    it('stays below the boot screen', () => {
        // The boot screen covers a window that is not ready to be interacted
        // with at all. A dialog over it would be a dialog nobody can act on.
        const boot = Number(css.match(/\.boot-screen\s*\{[^}]*?z-index:\s*(\d+)/s)?.[1]);
        const backdrop = css.slice(css.indexOf('.upgrade-modal-backdrop'), css.indexOf('.upgrade-modal {'));
        const mine = Number(backdrop.match(/z-index:\s*(\d+)/)?.[1]);
        expect(boot).toBeGreaterThan(0);
        expect(mine).toBeLessThan(boot);
    });
});

/**
 * THE CONTROLS THE OWNER COULD NOT FIND (genie#622).
 *
 * *"I should be able to open that window and close it without starting the
 * whole process over again."* There was no ✕, no Esc handler and no backdrop
 * dismiss — the backdrop was `role="presentation"` with no handler — so the one
 * control that took the sheet away was **Cancel the upgrade**, and it cancelled
 * the upgrade.
 *
 * The wiring cannot be seen from this lane, so what is asserted is that the
 * controls EXIST and that the dismissing ones go nowhere near the drain. How it
 * looks and feels is for the E2E and for a person.
 */
describe('the window can be closed without cancelling anything (genie#622)', () => {
    const master = readFileSync(path.resolve(__dirname, '../../pages/master.tsx'), 'utf8');
    const modal = master.slice(
        master.indexOf('function UpgradeModal('),
        master.indexOf('function UpdatePopover('),
    );
    const pill = master.slice(
        master.indexOf('function UpdatePill('),
        master.indexOf('function UpgradeModal('),
    );

    it('reads the two components it claims to be checking', () => {
        // The positive control, for both slices.
        expect(modal).toContain('upgrade-modal-backdrop');
        expect(pill).toContain('update-pill');
        expect(modal.length).toBeGreaterThan(500);
        expect(pill.length).toBeGreaterThan(500);
    });

    it('has all three dismissals this repo gives a modal', () => {
        // Matching WhatsNewModal rather than inventing: a ✕ in the header, a
        // backdrop that closes on mousedown, and Escape.
        expect(modal, 'no ✕ in the header').toContain('aria-label="Close"');
        expect(modal, 'the backdrop does not dismiss').toMatch(
            /upgrade-modal-backdrop"[\s\S]{0,160}onMouseDown=/,
        );
        expect(modal, 'no Escape handler').toContain("'Escape'");
    });

    it('cancels the upgrade in exactly ONE place — the button that says so', () => {
        // The failure this replaces: every way out of the sheet was a cancel.
        expect(modal.match(/drain\.cancel\(\)/g) ?? []).toHaveLength(1);
        const cancelButton = modal.slice(
            modal.indexOf('className="um-cancel"'),
            modal.indexOf('</footer>'),
        );
        expect(cancelButton).toContain('drain.cancel()');
        expect(cancelButton).toContain('Cancel the upgrade');
    });

    it('closes through the view store, which cannot reach the drain', () => {
        expect(modal).toContain('closeUpgradeView');
    });

    it('opens from the header control, so reopening is one click', () => {
        expect(pill).toContain('openUpgradeView');
    });

    it('shows the roster pane only when there is a roster', () => {
        // The preview half: notes with no drain is what someone wants before
        // deciding, and an empty "Agents" pane beside them says nothing.
        expect(modal).toMatch(/plan\.roster\s*&&/);
    });
});

/**
 * With no roster the sheet is ONE pane, not two with a hole where the agents
 * were. The grid is declared in CSS, so the preview layout is too.
 */
describe('the preview lays out as a single pane', () => {
    const css = readFileSync(path.resolve(__dirname, '../../styles/master.css'), 'utf8');

    it('reads the stylesheet it claims to be checking', () => {
        expect(css.length).toBeGreaterThan(10_000);
        expect(css).toContain('.upgrade-modal {');
    });

    it('drops the second column when there is no roster', () => {
        const start = css.indexOf('.upgrade-modal.is-preview');
        expect(start, 'no preview layout in the stylesheet').toBeGreaterThan(-1);
        const rule = css.slice(start, css.indexOf('}', start));
        expect(rule).toMatch(/grid-template-columns:\s*1fr/);
        expect(rule).not.toMatch(/agents/);
    });
});
