import { describe, expect, it } from 'vitest';
import {
    agentPanelLayout,
    ensureAgentPanels,
    type AgentPanelIO,
    type PlannedPanel,
} from '../panels';

/**
 * `panels` in a GApp manifest, finally consumed (Tynn #250).
 *
 * The declaration has been validated and bounded since the manifest work, and it
 * reaches the tab model — and then nothing read it, so an app asking for three
 * agent panels got one. The owner's reason for the field is a real need: "GApp
 * developers set how many and what kind of panels are available (for GApps that
 * need to have more than one agent session running at a time)".
 *
 * The hard part is not laying panels out, it is laying them out ONCE. A GApp's
 * panels live in its workspace and outlive the window, so a seed that ran on every
 * open would hand a user three more terminals every time they clicked the app's
 * pill. Everything below is really one property said four ways: the workspace ends
 * up with what the manifest asked for, no matter how many times you ask.
 */

const TERMINAL: PlannedPanel = { label: 'Terminal', type: 'terminal' };
const FILES: PlannedPanel = { label: 'Files', type: 'code' };

describe('the layout a manifest asks for', () => {
    it('is one terminal when the app declared nothing', () => {
        // `panels` defaults to `{ agents: 1 }` at validation, and an agent panel
        // with no stated kind is where an agent session runs — a terminal.
        expect(agentPanelLayout({ agents: 1 })).toEqual([TERMINAL]);
    });

    it('is as many panels as the app declared', () => {
        expect(agentPanelLayout({ agents: 3 })).toEqual([TERMINAL, TERMINAL, TERMINAL]);
    });

    it('cycles the declared kinds, so each one actually appears', () => {
        // `kinds` is the palette and `agents` is the count. Cycling is what makes
        // both declarations true at once: every kind the app named gets laid out,
        // and the number it asked for is the number it gets.
        expect(agentPanelLayout({ agents: 3, kinds: ['terminal', 'files'] })).toEqual([
            TERMINAL,
            FILES,
            TERMINAL,
        ]);
    });

    it('honours the count even when it is shorter than the palette', () => {
        // `agents` is explicit and bounded; a kind that does not fit inside it is
        // an over-declaration, not a reason to open a window the app did not ask
        // for.
        expect(agentPanelLayout({ agents: 1, kinds: ['files', 'terminal'] })).toEqual([FILES]);
    });

    it('falls back to a terminal for a kind Genie does not know', () => {
        // The validator refuses an unrecognised kind, so this is belt-and-braces.
        // It is here because the alternative is worse than wrong: an `undefined`
        // slot crashes the seeder, and a GApp window that will not open at all is
        // a worse answer to a typo in a manifest than one extra terminal.
        expect(agentPanelLayout({ agents: 1, kinds: ['telepathy'] })).toEqual([TERMINAL]);
    });

    it('renders `editor` as a code panel too, under its own name', () => {
        // Genie has ONE code surface — the tree and the editor are the same panel.
        // Both manifest kinds map onto it; what differs is what the panel is called,
        // which is the part the app actually declared an opinion about.
        expect(agentPanelLayout({ agents: 1, kinds: ['editor'] })).toEqual([
            { label: 'Editor', type: 'code' },
        ]);
    });
});

/** A workspace's panels, as the seeder sees them. */
function fakeWorkspace(existing: PlannedPanel[] = []) {
    const panels = [...existing];
    const io: AgentPanelIO = {
        countPanels: () => panels.length,
        createPanel: (panel) => {
            panels.push(panel);
        },
    };
    return { io, panels };
}

describe('seeding an app workspace', () => {
    it('lays the declared panels out on a workspace that has none', () => {
        const { io, panels } = fakeWorkspace();

        expect(ensureAgentPanels(io, { agents: 3, kinds: ['terminal', 'files'] })).toEqual([
            TERMINAL,
            FILES,
            TERMINAL,
        ]);
        expect(panels).toHaveLength(3);
    });

    it('creates NOTHING the second time — a reopen must not multiply panels', () => {
        // The whole point. A GApp's panels are workspace state; the window is not.
        const { io, panels } = fakeWorkspace();
        ensureAgentPanels(io, { agents: 3 });

        expect(ensureAgentPanels(io, { agents: 3 })).toEqual([]);
        expect(panels).toHaveLength(3);
    });

    it('tops a workspace up when an update declares MORE panels than it has', () => {
        // And it resumes the layout at the slot it left off at, so the palette
        // still cycles across the two runs rather than restarting.
        const { io, panels } = fakeWorkspace([TERMINAL]);

        expect(ensureAgentPanels(io, { agents: 3, kinds: ['terminal', 'files'] })).toEqual([
            FILES,
            TERMINAL,
        ]);
        expect(panels).toHaveLength(3);
    });

    it('never removes panels the user added beyond the declaration', () => {
        // "Ensure at least N" — a manifest says what an app needs to work, not what
        // the person using it is allowed to have.
        const { io, panels } = fakeWorkspace([TERMINAL, TERMINAL, TERMINAL, FILES]);

        expect(ensureAgentPanels(io, { agents: 2 })).toEqual([]);
        expect(panels).toHaveLength(4);
    });
});
