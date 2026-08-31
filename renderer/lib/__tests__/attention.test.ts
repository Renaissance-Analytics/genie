import { describe, it, expect } from 'vitest';
import { workspaceHasThumb, workspaceNeedsAttention } from '../attention';

/** The workspace-glow derivation (Part A) driving BOTH the rail button and the
 *  sidebar-menu workspace row. */
describe('workspaceNeedsAttention', () => {
    const specs = [{ id: 't1' }, { id: 't2' }, { id: 't3' }];

    it('glows when ANY terminal in the workspace needs attention', () => {
        expect(workspaceNeedsAttention(specs, new Set(['t2']))).toBe(true);
    });

    it('does NOT glow when no terminal in the workspace needs attention', () => {
        expect(workspaceNeedsAttention(specs, new Set(['other']))).toBe(false);
    });

    it('does NOT glow with an empty attention set', () => {
        expect(workspaceNeedsAttention(specs, new Set())).toBe(false);
    });

    it('does NOT glow for a workspace with no terminals', () => {
        expect(workspaceNeedsAttention([], new Set(['t1']))).toBe(false);
    });

    it('glows when multiple terminals need attention', () => {
        expect(workspaceNeedsAttention(specs, new Set(['t1', 't3']))).toBe(true);
    });
});

/**
 * A THUMBS-UP on a COLLAPSED workspace has nowhere to land.
 *
 * The thumb is drawn on an agent's SQUARE in the grid. Collapse the workspace and
 * the grid is not rendered — so the agent signals ready, the animation fires
 * against nothing, and the one person waiting to see it sees nothing. Readiness
 * that is only visible if you already had the row open is not a signal.
 *
 * The row already solves this for attention: `workspaceNeedsAttention` makes a
 * COLLAPSED row glow so a workspace can show it needs you without being opened.
 * This is the same rule for the same reason, which is why it lives beside it
 * rather than as a second mechanism in the component.
 */
describe('workspaceHasThumb', () => {
    it('is true when any agent in the workspace just thumbed', () => {
        expect(workspaceHasThumb([{ id: 'a' }, { id: 'b' }], new Set(['b']))).toBe(true);
    });

    it('is false when the thumb belongs to another workspace', () => {
        // The control that matters: a thumb must not light up every collapsed row
        // on the machine.
        expect(workspaceHasThumb([{ id: 'a' }], new Set(['elsewhere']))).toBe(false);
    });

    it('is false when nothing has thumbed', () => {
        expect(workspaceHasThumb([{ id: 'a' }], new Set())).toBe(false);
    });

    it('is false for a workspace with no agents at all', () => {
        expect(workspaceHasThumb([], new Set(['a']))).toBe(false);
    });
});
