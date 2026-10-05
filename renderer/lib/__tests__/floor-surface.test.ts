import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { floorSurface } from '../floor-surface';

describe('floorSurface', () => {
    it('shows the Deck and hides the grid for the Deck view', () => {
        expect(floorSurface({ kind: 'deck' })).toEqual({ showDeck: true, hideGrid: true });
    });

    it('shows the grid for the Workbench', () => {
        expect(floorSurface({ kind: 'workbench', workspaceId: 'w1' })).toEqual({
            showDeck: false,
            hideGrid: false,
        });
    });

    it('falls back to the grid for an agent route, not to a blank surface', () => {
        // The Agent view is a later phase. A link that resolves to nothing is worse
        // than one that resolves to the old thing.
        expect(floorSurface({ kind: 'agent', agentId: 'a1', tab: null })).toEqual({
            showDeck: false,
            hideGrid: false,
        });
    });

    it('never asks for the grid to be REMOVED — only concealed', () => {
        // The flags are separate on purpose, and this pins it: there is no state in
        // which the surface says "the grid should not exist".
        for (const view of [
            { kind: 'deck' } as const,
            { kind: 'workbench', workspaceId: 'w' } as const,
            { kind: 'agent', agentId: 'a', tab: null } as const,
        ]) {
            const s = floorSurface(view);
            expect(Object.keys(s).sort()).toEqual(['hideGrid', 'showDeck']);
        }
    });
});

/**
 * A SOURCE GUARD on the invariant the type cannot express.
 *
 * `hideGrid` is only honoured if `Floor.tsx` actually renders the grid in every
 * state. Make it conditional and the flag becomes decoration while every pty resets
 * on the way back from the Deck — a failure that looks like "the terminals cleared
 * themselves", nowhere near the change that caused it.
 *
 * CRLF-normalised before matching, per genie#517.
 */
describe('Floor keeps the grid mounted', () => {
    const ROOT = path.resolve(__dirname, '..', '..', '..');
    const floor = fs
        .readFileSync(path.join(ROOT, 'renderer/components/Master/Floor.tsx'), 'utf8')
        .replace(/\r\n/g, '\n');

    it('renders TerminalGrid exactly once', () => {
        expect(floor.match(/<TerminalGrid\b/g) ?? []).toHaveLength(1);
    });

    it('does not put TerminalGrid behind a condition', () => {
        // The two shapes a conditional render takes in this codebase.
        expect(floor).not.toMatch(/&&\s*<TerminalGrid\b/);
        expect(floor).not.toMatch(/\?\s*\(?\s*<TerminalGrid\b/);
    });

    it('hides the grid with a style rather than by not rendering it', () => {
        expect(floor).toMatch(/hideGrid/);
        expect(floor).toMatch(/display: 'none'/);
    });

    it('positive control: the guard reads the real file', () => {
        // Without this, every assertion above would also pass against an empty string.
        expect(floor).toContain('export default function Floor');
    });
});
