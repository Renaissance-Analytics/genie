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

/**
 * The declared roster reaching the layout (genie#245).
 *
 * `manifest.agents` had three consumers — the validator, the copy plan and the
 * consent screen — and the panel seeder was not one of them. A developer shipped a
 * persona, passed validation, was named on the consent screen, and got an empty
 * terminal. Binding is what makes the roster mean something at runtime.
 */
describe('binding the declared agents to their panels', () => {
    const STRATEGIST = { name: 'Strategist', persona: 'strategist.md' };
    const REVIEWER = { name: 'Reviewer', persona: 'reviewer/persona.md' };

    it('binds each slot to the agent that runs in it', () => {
        expect(agentPanelLayout({ agents: 2 }, [STRATEGIST, REVIEWER])).toEqual([
            { label: 'Strategist', type: 'terminal', agent: STRATEGIST },
            { label: 'Reviewer', type: 'terminal', agent: REVIEWER },
        ]);
    });

    it('names the panel after the agent, not "Terminal"', () => {
        // The visible half of the bug: N panels all called "Terminal" is what an
        // app whose roster was never read looks like from the outside.
        expect(agentPanelLayout({ agents: 1 }, [STRATEGIST])[0]?.label).toBe('Strategist');
    });

    it('leaves an app with no declared agents exactly as it was', () => {
        // Most GApps ship no agent of their own. They must still get their panels,
        // and those panels must still be plain.
        expect(agentPanelLayout({ agents: 2 })).toEqual([TERMINAL, TERMINAL]);
        expect(agentPanelLayout({ agents: 2 }, [])).toEqual([TERMINAL, TERMINAL]);
    });

    it('cycles the roster when the app declared more panels than agents', () => {
        // Same rule the palette already has: the COUNT is the explicit, bounded
        // declaration, so it wins, and the roster cycles under it. An app asking
        // for three panels with one agent wants three sessions of that agent.
        expect(agentPanelLayout({ agents: 3 }, [STRATEGIST]).map((p) => p.agent?.name)).toEqual([
            'Strategist',
            'Strategist',
            'Strategist',
        ]);
    });

    it('only binds a slot an agent can actually run in', () => {
        // `files` and `editor` are the code surface. Binding a persona to one would
        // record an agent that no TUI is ever launched for — the same silent lie in
        // a different place — so the roster skips them and lands on the next
        // terminal, which is also how every declared agent still gets a home.
        const layout = agentPanelLayout({ agents: 3, kinds: ['terminal', 'files'] }, [
            STRATEGIST,
            REVIEWER,
        ]);
        expect(layout.map((p) => [p.type, p.agent?.name])).toEqual([
            ['terminal', 'Strategist'],
            ['code', undefined],
            ['terminal', 'Reviewer'],
        ]);
    });
});

/** A workspace's panels, as the seeder sees them. */
function fakeWorkspace(existing: PlannedPanel[] = [], mayStartAgents?: AgentPanelIO['mayStartAgents']) {
    const panels = [...existing];
    const io: AgentPanelIO = {
        countPanels: () => panels.length,
        createPanel: (panel) => {
            panels.push(panel);
        },
        ...(mayStartAgents ? { mayStartAgents } : {}),
    };
    return { io, panels };
}

describe('seeding an app workspace', () => {
    it('lays the declared panels out on a workspace that has none', () => {
        const { io, panels } = fakeWorkspace();

        expect(ensureAgentPanels(io, { agents: 3, kinds: ['terminal', 'files'] }).created).toEqual([
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

        expect(ensureAgentPanels(io, { agents: 3 }).created).toEqual([]);
        expect(panels).toHaveLength(3);
    });

    it('tops a workspace up when an update declares MORE panels than it has', () => {
        // And it resumes the layout at the slot it left off at, so the palette
        // still cycles across the two runs rather than restarting.
        const { io, panels } = fakeWorkspace([TERMINAL]);

        expect(ensureAgentPanels(io, { agents: 3, kinds: ['terminal', 'files'] }).created).toEqual([
            FILES,
            TERMINAL,
        ]);
        expect(panels).toHaveLength(3);
    });

    it('never removes panels the user added beyond the declaration', () => {
        // "Ensure at least N" — a manifest says what an app needs to work, not what
        // the person using it is allowed to have.
        const { io, panels } = fakeWorkspace([TERMINAL, TERMINAL, TERMINAL, FILES]);

        expect(ensureAgentPanels(io, { agents: 2 }).created).toEqual([]);
        expect(panels).toHaveLength(4);
    });
});

/**
 * The agent-terminal cap (Tynn #117) meeting a GApp.
 *
 * A GApp seeding N agent panels is precisely the runaway the cap exists for, so
 * its agents COUNT against it — they are agent terminals like any other, and the
 * app is spending someone else's compute to open them.
 *
 * Refusal is ALL-OR-NOTHING, for two reasons. Half a roster is the same silent
 * lie the whole issue is about — the user consented to a named set and would
 * quietly get fewer. And the seeder converges by counting what the workspace
 * already has, so a partial seed would leave the SKIPPED slots permanently
 * unreachable: the next open would slice past them.
 */
describe('a GApp meeting the agent-terminal cap', () => {
    const ROSTER = [{ name: 'Strategist', persona: 'strategist.md' }];

    it('asks for exactly as many agent terminals as it is about to start', () => {
        const asked: number[] = [];
        const { io } = fakeWorkspace([], (n) => {
            asked.push(n);
            return { allowed: true };
        });

        ensureAgentPanels(io, { agents: 3, kinds: ['terminal', 'files'] }, ROSTER);
        expect(asked).toEqual([2]);
    });

    it('creates NOTHING and says why when the cap refuses', () => {
        const { io, panels } = fakeWorkspace([], () => ({
            allowed: false,
            reason: 'This workspace is at its limit of 2 agent terminals.',
        }));

        const seeded = ensureAgentPanels(io, { agents: 2 }, ROSTER);
        expect(seeded.created).toEqual([]);
        expect(seeded.refused).toContain('at its limit');
        expect(panels).toHaveLength(0);
    });

    it('never asks about an app that declared no agents', () => {
        // A plain panel is not an agent terminal; rationing a GApp's Files tab
        // against the agent cap would be the cap applying to the wrong thing.
        let asked = false;
        const { io, panels } = fakeWorkspace([], () => {
            asked = true;
            return { allowed: false, reason: 'no' };
        });

        expect(ensureAgentPanels(io, { agents: 2 }).created).toHaveLength(2);
        expect(asked).toBe(false);
        expect(panels).toHaveLength(2);
    });
});
