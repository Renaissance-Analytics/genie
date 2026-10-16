import { describe, expect, it } from 'vitest';
import { CHAT_STRIP_WIDTH, DOCK_SLOTS, DOCK_WIDTH, dockReserve, pinPanel } from '../src/core/dock.js';

/**
 * THE DOCK'S GEOMETRY, which has three shipped failures behind it.
 */

describe('the width', () => {
    it('is ONE number, and the reserve is that same number', () => {
        /**
         * The reserve the content row gives up and the width the panel occupies are the same
         * token. **Two numbers is a panel overlapping the content by their difference** — which
         * shipped twice, and the second time it was a three-pixel overlap nobody could name.
         *
         * Asserted as an identity rather than against a literal, because the thing that must
         * hold is that they cannot diverge.
         */
        expect(dockReserve('chat')).toBe(DOCK_WIDTH);
        expect(dockReserve('files')).toBe(DOCK_WIDTH);
        expect(dockReserve('lists')).toBe(DOCK_WIDTH);
    });

    it('is the 380px the design states', () => {
        // Pinned separately, so changing the constant cannot silently redefine the design.
        expect(DOCK_WIDTH).toBe(380);
    });

    it('reserves only the chat strip when nothing is pinned', () => {
        // With nothing pinned the chat is a strip of tabs on the right edge (the owner: "always present"), and it
        // keeps its own width. An unpinned FLYOUT adds nothing to that — it overlays, and nothing underneath moves.
        expect(dockReserve(null)).toBe(CHAT_STRIP_WIDTH);
        expect(CHAT_STRIP_WIDTH).toBeLessThan(DOCK_WIDTH);
    });
});

describe('one slot', () => {
    it('allows exactly one panel', () => {
        // Chat and files side by side is a 170px tree beside a 170px chat: two useless panels.
        // Both at once means popping the file panel out into its own window.
        expect(DOCK_SLOTS).toBe(1);
    });

    it('REPLACES the pinned panel, and reports what it displaced', () => {
        // Reported so the UI can show a handoff — the displaced panel's pin lamp going out —
        // rather than a silent close. A panel that vanishes without a visible cause reads as a
        // bug every time.
        expect(pinPanel('files', 'chat', false)).toEqual({ pinned: 'chat', replaced: 'files', refused: null });
        expect(pinPanel('chat', 'lists', false)).toEqual({ pinned: 'lists', replaced: 'chat', refused: null });
    });

    it('pins into an empty slot with nothing displaced', () => {
        expect(pinPanel(null, 'chat', false)).toEqual({ pinned: 'chat', replaced: null, refused: null });
    });

    it('UNPINS when the same panel is pinned again', () => {
        // The control is a toggle, and a toggle that does nothing on the second press is a
        // control people press twice and then distrust.
        expect(pinPanel('chat', 'chat', false)).toEqual({ pinned: null, replaced: null, refused: null });
    });
});

describe('a file panel with unsaved edits', () => {
    it('REFUSES to be replaced, and says why', () => {
        // Nothing a person typed is discarded to make room for a panel.
        const outcome = pinPanel('files', 'chat', true);

        expect(outcome.pinned).toBe('files');
        expect(outcome.replaced).toBeNull();
        expect(outcome.refused).toContain('unsaved edits');
        expect(outcome.refused).toContain('pop the panel out');
    });

    it('can still be unpinned by its own control — the refusal is about REPLACEMENT', () => {
        // Closing your own panel is your decision. Refusing that too would trap someone in a
        // panel they are trying to put away.
        expect(pinPanel('files', 'files', true)).toEqual({ pinned: null, replaced: null, refused: null });
    });

    it('does not refuse when the edits are saved — the positive control', () => {
        // Without this, "files refuses replacement" passes equally against a rule that refuses
        // every replacement of a file panel.
        expect(pinPanel('files', 'chat', false).refused).toBeNull();
    });

    it('does not let a CHAT panel refuse on the file panel’s behalf', () => {
        // COUNT over every current panel: only `files` may refuse, and only with unsaved
        // edits. A chat panel that inherited the refusal would be unreplaceable for a reason
        // that has nothing to do with it.
        const refusals = (['chat', 'lists', 'files'] as const)
            .map((current) => pinPanel(current, 'lists', true))
            .filter((o) => o.refused !== null);

        expect(refusals).toHaveLength(1);
    });
});
