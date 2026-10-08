import { describe, expect, it } from 'vitest';
import {
    DOCKABLE,
    DRAWER_IDS,
    closeDrawerNext,
    isDocked,
    isDrawerOpen,
    openDrawerNext,
    pinDockNext,
    somethingCoversTheFloor,
    type DrawerId,
} from '../drawers';

/**
 * ONE DRAWER AT A TIME, and the three surfaces that are deliberately NOT drawers.
 *
 * P7 asks for *"one `Drawer` with a single `openDrawer: DrawerId | null`, making two-open-at-once
 * structurally impossible"*, replacing fourteen hand-maintained booleans whose OR answers one
 * question. `master.tsx` states the risk itself: *"a missing flag means Escape navigates out from
 * under an open panel."*
 *
 * The owner's ruling, asked directly about the conflict with the Lists dock, is **"a pinned dock is
 * NOT a drawer"** — exclusivity would make a pin useless, which is the one thing a pin is for. These
 * tests encode that ruling and the two consequences of following it consistently.
 */

describe('exclusivity — the structural guarantee', () => {
    it('opening a drawer closes whatever was open', () => {
        expect(openDrawerNext('docs')).toBe('docs');
        // There is no state in which two are open, because the state cannot express it. That is the
        // difference between this and fourteen booleans that merely happen to be false.
        expect(openDrawerNext('flows')).toBe('flows');
    });

    it('closing the OPEN drawer clears the slot', () => {
        expect(closeDrawerNext('docs', 'docs')).toBeNull();
    });

    it('closing a drawer that is NOT open leaves the slot alone', () => {
        /**
         * The guard that stops a flicker nobody can reproduce. A panel's `onClose` can fire after
         * something else has taken the slot — a backdrop click racing a ⌘K feature activation, or a
         * React cleanup running late. Closing unconditionally would shut the NEW panel.
         */
        expect(closeDrawerNext('flows', 'docs')).toBe('flows');
        expect(closeDrawerNext(null, 'docs')).toBeNull();
    });

    it('answers which one is open without the caller comparing strings', () => {
        expect(isDrawerOpen('lists', 'lists')).toBe(true);
        expect(isDrawerOpen('lists', 'docs')).toBe(false);
        expect(isDrawerOpen(null, 'docs')).toBe(false);
    });

    it('covers every right-edge panel that exists today', () => {
        /**
         * Started as eleven — the fourteen flags minus the three non-drawers — and is now
         * twelve: §5.4's chat is a drawer too, and DOCKABLE on top of that. §5.3's file panel
         * joins when it is built. Still an exact set, which is the point: a new panel has to be
         * classified here rather than quietly getting its own boolean, and that is what this
         * line went red for.
         */
        expect([...DRAWER_IDS].sort()).toEqual([
            'agent-inbox',
            'appstore',
            'chat',
            'docs',
            'flows',
            'genie-os',
            'github-caps',
            'issuewatch',
            'lists',
            'questions',
            'sharing',
            'tasks',
        ]);
    });
});

describe('somethingCoversTheFloor — what Escape actually asks', () => {
    const base = {
        openDrawer: null as DrawerId | null,
        pinnedDock: null,
        paletteOpen: false,
        onboardingOpen: false,
        recipeLauncherOpen: false,
    };

    it('nothing open means nothing covers the Floor', () => {
        expect(somethingCoversTheFloor(base)).toBe(false);
    });

    it('an open drawer covers it', () => {
        expect(somethingCoversTheFloor({ ...base, openDrawer: 'docs' })).toBe(true);
    });

    it('a PINNED Lists panel does NOT cover it — the owner\'s ruling, made concrete', () => {
        /**
         * `master.css` says the gutter reserve exists *"so a pinned panel covers nothing"*: a docked
         * panel sits beside the content, not over it. So Escape should leave for the Deck exactly as
         * it would with no panel at all — treating it as an overlay would trap Escape behind a panel
         * the person deliberately docked, which is the opposite of what pinning is for.
         */
        expect(somethingCoversTheFloor({ ...base, openDrawer: 'lists', pinnedDock: 'lists' })).toBe(false);
    });

    it('a FLOATING Lists panel does cover it', () => {
        // The same panel, unpinned, is an ordinary drawer over the content. The pin is the whole
        // distinction, which is why the dock slot is an input rather than an assumption.
        expect(somethingCoversTheFloor({ ...base, openDrawer: 'lists', pinnedDock: null })).toBe(true);
    });

    it('pinning does not excuse a DIFFERENT open drawer', () => {
        // The exception is scoped to Lists. Someone with Lists pinned who opens Docs is still looking
        // at something over the Floor.
        expect(somethingCoversTheFloor({ ...base, openDrawer: 'docs', pinnedDock: 'lists' })).toBe(true);
    });

    it('the palette covers it, and is NOT a drawer', () => {
        /**
         * genie#820 was exactly about ⌘K needing to open OVER a flyout — it painted under the scrim
         * and was silently unclickable. So the palette must not be in `DrawerId`: making them
         * exclusive would close your panel the moment you reached for the command window, which is a
         * regression in feel wearing a structural improvement's clothes.
         */
        expect(DRAWER_IDS as readonly string[]).not.toContain('palette');
        expect(somethingCoversTheFloor({ ...base, paletteOpen: true })).toBe(true);
    });

    it('the palette can be open WITH a drawer, which is the point of keeping it separate', () => {
        expect(somethingCoversTheFloor({ ...base, openDrawer: 'docs', paletteOpen: true })).toBe(true);
    });

    it('first run covers it, and is not a drawer either', () => {
        // It opens by itself on an empty workstation; a flyout closing it would be a flyout
        // cancelling onboarding.
        expect(DRAWER_IDS as readonly string[]).not.toContain('onboarding');
        expect(somethingCoversTheFloor({ ...base, onboardingOpen: true })).toBe(true);
    });

    it('the recipe launcher covers it, and is not a drawer', () => {
        // A modal raised from a workspace row. Nothing about it reserves gutter space or competes for
        // the right edge.
        expect(somethingCoversTheFloor({ ...base, recipeLauncherOpen: true })).toBe(true);
    });
});

/**
 * THE ONE DOCK SLOT — §0.3 of the agent-surfaces design, and the generalisation of the
 * owner's ruling that *"a pinned dock is NOT a drawer"*.
 *
 * `listsPinned` was a boolean because Lists was the only pinnable panel. §5.4 adds a pinnable
 * chat and §5.3 a pinnable file panel, and two booleans would make "both pinned" representable
 * — three competing panels at the right edge, each reserving its own gutter. The design is
 * explicit that at most one is docked, with the owner's own escape valve for wanting two: the
 * file panel pops into its own window.
 *
 * So the slot is a VALUE, exactly as `openDrawer` replaced eleven booleans, and for the same
 * reason: the illegal state stops being merely absent and becomes unrepresentable.
 */
describe('the single dock slot', () => {
    it('lists every panel that may be docked', () => {
        // `files` (§5.3) is deliberately ABSENT until the panel exists: the dock-width guard
        // reads this list, and an id with no panel would promise a reserve nothing sets.
        expect([...DOCKABLE].sort()).toEqual(['chat', 'lists']);
    });

    it('pinning one dock replaces the other, because there is one slot', () => {
        expect(pinDockNext('lists', 'chat')).toBe('chat');
        expect(pinDockNext(null, 'lists')).toBe('lists');
    });

    it('pinning the dock that is already pinned UNPINS it — the control is a toggle', () => {
        // The header pin is one button, and a pin that cannot unpin is a dead control once
        // pressed. This is what made the Lists icon dead while docked, before genie#589.
        expect(pinDockNext('lists', 'lists')).toBeNull();
        expect(pinDockNext('chat', 'chat')).toBeNull();
    });

    it('treats a PINNED open panel as beside the content, whichever panel it is', () => {
        /**
         * The owner's ruling, generalised: a pin exists so the panel stays up WHILE you work,
         * so it cannot be the thing that makes Escape navigate out from under you. Previously
         * this was hard-coded to Lists; now any docked panel gets it, which is what stops the
         * chat flyout inheriting a bug the Lists panel already had fixed.
         */
        expect(
            somethingCoversTheFloor({
                openDrawer: 'chat',
                pinnedDock: 'chat',
                paletteOpen: false,
                onboardingOpen: false,
                recipeLauncherOpen: false,
            }),
        ).toBe(false);
    });

    it('still counts an open panel that is NOT the pinned one as covering', () => {
        // The positive control: pinning chat must not make an open Sharing flyout invisible to
        // the overlay question, or Escape would navigate out from under it.
        expect(
            somethingCoversTheFloor({
                openDrawer: 'sharing',
                pinnedDock: 'chat',
                paletteOpen: false,
                onboardingOpen: false,
                recipeLauncherOpen: false,
            }),
        ).toBe(true);
    });

    it('counts an UNPINNED chat as covering, because unpinned it overlays', () => {
        // The board: unpinned the flyout "sits over the right edge with a shadow" and Esc
        // closes it. So unpinned it IS an overlay and Escape belongs to it.
        expect(
            somethingCoversTheFloor({
                openDrawer: 'chat',
                pinnedDock: null,
                paletteOpen: false,
                onboardingOpen: false,
                recipeLauncherOpen: false,
            }),
        ).toBe(true);
    });

    it('reports which panel is docked only when it is also OPEN', () => {
        // Pinned-but-closed reserves nothing. `listsPinned` was "when it shows, dock it" —
        // a preference, not a state — and conflating the two is what made the header icon a
        // dead control while the panel was docked.
        expect(isDocked('lists', 'lists')).toBe(true);
        expect(isDocked('lists', null)).toBe(false);
        expect(isDocked('lists', 'sharing')).toBe(false);
        expect(isDocked(null, 'lists')).toBe(false);
    });
});
