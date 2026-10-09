import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { floorSurface } from '../floor-surface';

describe('floorSurface', () => {
    it('shows the grid for the DEFAULT view', () => {
        // The default must not hide the grid. An earlier version defaulted the route to
        // the Deck and every panel test on every platform failed.
        expect(floorSurface({ kind: 'grid' })).toEqual({
            showDeck: false,
            showDashboard: false,
            hideGrid: false,
            showAgent: null,
            showGridChrome: true,
        });
    });

    it('shows the Deck and hides the grid for the Deck view', () => {
        expect(floorSurface({ kind: 'deck' })).toEqual({
            showDeck: true,
            showDashboard: false,
            hideGrid: true,
            showAgent: null,
            // The grid's own chrome goes with the grid — see `showGridChrome`.
            showGridChrome: false,
        });
    });

    it('shows the grid for the Workbench', () => {
        expect(floorSurface({ kind: 'workbench', workspaceId: 'w1' })).toEqual({
            showDeck: false,
            showDashboard: false,
            hideGrid: false,
            showAgent: null,
            showGridChrome: true,
        });
    });

    it('resolves an agent route to that AGENT, no longer falling back to the grid', () => {
        // It used to fall back because the Agent view did not exist -- this file said so.
        // It exists now, so the link resolves to what it names.
        expect(floorSurface({ kind: 'agent', agentId: 'a1', tab: null, lanes: null })).toEqual({
            showDeck: false,
            showDashboard: false,
            hideGrid: true,
            showAgent: 'a1',
            showGridChrome: false,
        });
    });

    it('never asks for the grid to be REMOVED — only concealed', () => {
        // The flags are separate on purpose, and this pins it: there is no state in
        // which the surface says "the grid should not exist".
        for (const view of [
            { kind: 'grid' } as const,
            { kind: 'deck' } as const,
            { kind: 'dashboard' } as const,
            { kind: 'workbench', workspaceId: 'w' } as const,
            { kind: 'agent', agentId: 'a', tab: null, lanes: null } as const,
        ]) {
            const s = floorSurface(view);
            // The CLOSED LIST is the assertion: a new flag has to be added here, in a diff a
            // human reads, which is how `showGridChrome` arrived — and how `showDashboard`
            // arrived, because this line went red the moment it was added. A flag named
            // anything like `unmountGrid` could not get in without this changing.
            expect(Object.keys(s).sort()).toEqual([
                'hideGrid',
                'showAgent',
                'showDashboard',
                'showDeck',
                'showGridChrome',
            ]);
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
        expect(floorSurface({ kind: 'agent', agentId: 'a1', tab: null, lanes: null })).toEqual({
            showDeck: false,
            showDashboard: false,
            hideGrid: true,
            showAgent: 'a1',
            showGridChrome: false,
        });
    });

    it('CONCEALS the grid rather than unmounting it', () => {
        // Same hazard as the Deck: every terminal panel owns a live xterm bound to a pty,
        // and unmounting the grid would remount them all and reset the terminals.
        expect(floorSurface({ kind: 'agent', agentId: 'a1', tab: null, lanes: null }).hideGrid).toBe(true);
    });

    it('shows no agent for any other route', () => {
        expect(floorSurface({ kind: 'grid' }).showAgent).toBeNull();
        expect(floorSurface({ kind: 'deck' }).showAgent).toBeNull();
        expect(floorSurface({ kind: 'workbench', workspaceId: 'w1' }).showAgent).toBeNull();
    });
});

describe('the GRID TOOLBAR belongs to the grid', () => {
    /**
     * P7: *"the layout control off the default path."* Measured, it is worse than one control —
     * the whole `Toolbar` renders unconditionally, so on the Deck (the default surface since P6)
     * a person sees the layout picker, Add view, Add terminal and Run recipe for a grid that is
     * not on screen. Every one of those acts on `activeWorkspaceId`, and the Deck is
     * cross-workspace by definition.
     *
     * The rule is the obvious one and it is already derivable: grid chrome appears with the grid.
     * It is a THIRD flag rather than `!hideGrid` at the call site, because the two existing flags
     * answer "what to add" and "what to conceal" and neither of them means "what to offer" — and
     * because a flag can be tested where a negated expression inside a 5,000-line component
     * cannot.
     *
     * It does NOT unmount the grid. That distinction is the whole reason `hideGrid` exists: every
     * panel owns a live xterm bound to a pty, and remounting resets the terminal.
     */
    it('offers the toolbar on the grid and the Workbench', () => {
        expect(floorSurface({ kind: 'grid' }).showGridChrome).toBe(true);
        expect(floorSurface({ kind: 'workbench', workspaceId: 'w1' }).showGridChrome).toBe(true);
    });

    it('does NOT offer it on the Deck', () => {
        expect(floorSurface({ kind: 'deck' }).showGridChrome).toBe(false);
    });

    it('does NOT offer it on an Agent view', () => {
        // The Agent view has its own header, with the controls that act on an agent. A layout
        // picker for a grid behind it is chrome for somewhere else.
        expect(floorSurface({ kind: 'agent', agentId: 'a1', tab: null, lanes: null }).showGridChrome).toBe(false);
    });

    it('tracks the grid exactly — it is never offered while the grid is concealed', () => {
        // The property, stated once rather than per case: chrome for a surface nobody can see is
        // the defect, whichever route produced it.
        for (const view of [
            { kind: 'grid' } as const,
            { kind: 'deck' } as const,
            { kind: 'workbench', workspaceId: 'w1' } as const,
            { kind: 'agent', agentId: 'a1', tab: null, lanes: null } as const,
        ]) {
            const surface = floorSurface(view);
            expect(surface.showGridChrome).toBe(!surface.hideGrid);
        }
    });

    it('still never unmounts the grid, on any route', () => {
        // The one thing this must not become. `hideGrid` conceals; nothing here destroys.
        for (const view of [
            { kind: 'grid' } as const,
            { kind: 'deck' } as const,
            { kind: 'agent', agentId: 'a1', tab: null, lanes: null } as const,
        ]) {
            expect(Object.keys(floorSurface(view))).not.toContain('unmountGrid');
        }
    });
});


describe('the Workflow Dashboard surface', () => {
    it('mounts the Dashboard and conceals — never unmounts — the grid', () => {
        /**
         * The same contract as the Deck, and the same reason: a panel's xterm is bound to a
         * live pty, so a surface shown above the grid conceals it. `showDashboard` is its own
         * flag rather than a widened `showDeck` because the two surfaces answer different
         * questions and the route has to be able to say which one it means.
         */
        expect(floorSurface({ kind: 'dashboard' })).toEqual({
            showDeck: false,
            showDashboard: true,
            hideGrid: true,
            showAgent: null,
            showGridChrome: false,
        });
    });

    it('is never mounted at the same time as the Deck', () => {
        // They are siblings, not layers. A route names one subject, and a state where both are
        // mounted would be two cross-workspace surfaces competing for the same space.
        for (const view of [
            { kind: 'deck' } as const,
            { kind: 'dashboard' } as const,
            { kind: 'grid' } as const,
            { kind: 'workbench', workspaceId: 'w1' } as const,
            { kind: 'agent', agentId: 'a1', tab: null, lanes: null } as const,
        ]) {
            const surface = floorSurface(view);
            expect(surface.showDeck && surface.showDashboard).toBe(false);
        }
    });
});
