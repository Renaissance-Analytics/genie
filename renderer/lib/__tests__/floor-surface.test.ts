import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { floorSurface } from '../floor-surface';

describe('floorSurface', () => {
    it('shows the grid for the DEFAULT view', () => {
        // The default must not hide the grid. An earlier version defaulted the route to
        // the Deck and every panel test on every platform failed.
        expect(floorSurface({ kind: 'grid' })).toEqual({ showDeck: false, hideGrid: false, showAgent: null });
    });

    it('shows the Deck and hides the grid for the Deck view', () => {
        expect(floorSurface({ kind: 'deck' })).toEqual({ showDeck: true, hideGrid: true, showAgent: null });
    });

    it('shows the grid for the Workbench', () => {
        expect(floorSurface({ kind: 'workbench', workspaceId: 'w1' })).toEqual({
            showDeck: false,
            hideGrid: false,
            showAgent: null,
        });
    });

    it('resolves an agent route to that AGENT, no longer falling back to the grid', () => {
        // It used to fall back because the Agent view did not exist -- this file said so.
        // It exists now, so the link resolves to what it names.
        expect(floorSurface({ kind: 'agent', agentId: 'a1', tab: null })).toEqual({
            showDeck: false,
            hideGrid: true,
            showAgent: 'a1',
        });
    });

    it('never asks for the grid to be REMOVED — only concealed', () => {
        // The flags are separate on purpose, and this pins it: there is no state in
        // which the surface says "the grid should not exist".
        for (const view of [
            { kind: 'grid' } as const,
            { kind: 'deck' } as const,
            { kind: 'workbench', workspaceId: 'w' } as const,
            { kind: 'agent', agentId: 'a', tab: null } as const,
        ]) {
            const s = floorSurface(view);
            expect(Object.keys(s).sort()).toEqual(['hideGrid', 'showAgent', 'showDeck']);
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

describe('the agent route now RENDERS the agent view', () => {
    it('reports the agent to show, and conceals the grid', () => {
        // It used to fall back to the grid because the Agent view did not exist. It does
        // now, so a link to an agent resolves to that agent.
        expect(floorSurface({ kind: 'agent', agentId: 'a1', tab: null })).toEqual({
            showDeck: false,
            hideGrid: true,
            showAgent: 'a1',
        });
    });

    it('CONCEALS the grid rather than unmounting it', () => {
        // Same hazard as the Deck: every terminal panel owns a live xterm bound to a pty,
        // and unmounting the grid would remount them all and reset the terminals.
        expect(floorSurface({ kind: 'agent', agentId: 'a1', tab: null }).hideGrid).toBe(true);
    });

    it('shows no agent for any other route', () => {
        expect(floorSurface({ kind: 'grid' }).showAgent).toBeNull();
        expect(floorSurface({ kind: 'deck' }).showAgent).toBeNull();
        expect(floorSurface({ kind: 'workbench', workspaceId: 'w1' }).showAgent).toBeNull();
    });
});
