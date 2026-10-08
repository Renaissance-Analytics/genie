import { describe, expect, it } from 'vitest';
import {
    DRAWER_IDS,
    closeDrawerNext,
    isDrawerOpen,
    openDrawerNext,
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
        // Eleven, from the fourteen flags minus the three non-drawers. Asserted as an exact set so a
        // new panel has to be classified here rather than quietly getting its own boolean.
        expect([...DRAWER_IDS].sort()).toEqual([
            'agent-inbox',
            'appstore',
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
        listsPinned: false,
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
        expect(somethingCoversTheFloor({ ...base, openDrawer: 'lists', listsPinned: true })).toBe(false);
    });

    it('a FLOATING Lists panel does cover it', () => {
        // The same panel, unpinned, is an ordinary drawer over the content. The pin is the whole
        // distinction, which is why `listsPinned` is an input rather than an assumption.
        expect(somethingCoversTheFloor({ ...base, openDrawer: 'lists', listsPinned: false })).toBe(true);
    });

    it('pinning does not excuse a DIFFERENT open drawer', () => {
        // The exception is scoped to Lists. Someone with Lists pinned who opens Docs is still looking
        // at something over the Floor.
        expect(somethingCoversTheFloor({ ...base, openDrawer: 'docs', listsPinned: true })).toBe(true);
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
