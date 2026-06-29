import { describe, it, expect } from 'vitest';
import { workspaceNeedsAttention } from '../attention';

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
