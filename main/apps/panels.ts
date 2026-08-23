/**
 * PURE. The agent panels a GApp's manifest asks for, and laying them out ONCE
 * (Tynn #250).
 *
 * `panels` has been validated and bounded since the manifest work and it reaches
 * the tab model in `window-tabs.ts` — and then nothing consumed it, so an app
 * declaring three agent panels got one. The field exists for a stated need: a GApp
 * that needs more than one agent session running at a time says so, and Genie lays
 * that out.
 *
 * The interesting part is not the layout, it is the IDEMPOTENCY. A GApp's panels
 * are WORKSPACE state — they outlive the window, keep their ptys and their
 * scrollback, and are the user's to close. So seeding cannot be "create N on
 * open": that would hand somebody three more terminals every time they clicked the
 * app's pill. It is "ensure at least N", keyed off what the workspace already has,
 * which converges from any starting point — a fresh install, a reopen, or an
 * update that raised the count.
 */

import type { AppAgentDecl, AppPanels } from './manifest';

/** One panel to lay out: the Genie view that renders it, and what to call it. */
export interface PlannedPanel {
    label: string;
    /** A Genie view type. `code` is the tree-and-editor panel. */
    type: 'terminal' | 'code';
    /**
     * The DECLARED agent this slot runs, when the app shipped one for it
     * (genie#245).
     *
     * Absent means a plain panel — most GApps ship no agent of their own, and the
     * ones that do get exactly as many bound slots as their roster reaches. What
     * the binding buys is the thing `manifest.agents` never had: a consumer. It was
     * validated, copied and read out on the consent screen, and then the seeder
     * created a bare terminal, so a developer who shipped a persona got an empty
     * shell and no error.
     */
    agent?: AppAgentDecl;
}

/**
 * Manifest kind → the panel Genie opens for it.
 *
 * `files` and `editor` land on the SAME view type because Genie has one code
 * surface — the tree and the editor are two halves of a single panel. What the two
 * kinds actually differ in is what the panel is called, which is the part the app
 * declared an opinion about, so that is the part that survives the mapping.
 */
const PANEL_FOR_KIND: Record<string, PlannedPanel> = {
    terminal: { label: 'Terminal', type: 'terminal' },
    files: { label: 'Files', type: 'code' },
    editor: { label: 'Editor', type: 'code' },
};

/** An agent panel with no stated kind is where an agent session runs. */
const DEFAULT_PANEL: PlannedPanel = PANEL_FOR_KIND.terminal!;

/**
 * The full layout a manifest describes, in slot order.
 *
 * `kinds` is the palette and `agents` is the count, so the palette CYCLES: that is
 * what makes both declarations true at once — every kind the app named gets laid
 * out, and the number it asked for is the number it gets. Where the two disagree
 * the count wins, because it is the explicit, bounded one.
 *
 * The declared ROSTER cycles under the same rule, for the same reason — an app
 * asking for three panels and shipping one agent wants three sessions of it. It
 * cycles across the slots an agent can actually RUN in, though, skipping the code
 * surfaces: binding a persona to the Files panel would record an agent that no TUI
 * is ever launched for, which is the silent lie this whole change removes, moved
 * one panel over. Skipping is also what keeps every declared agent reaching a home
 * when a palette interleaves terminals with code panels.
 */
export function agentPanelLayout(
    panels: AppPanels,
    agents?: readonly AppAgentDecl[],
): PlannedPanel[] {
    const kinds = panels.kinds?.length ? panels.kinds : null;
    const roster = agents?.length ? agents : null;
    let bound = 0;
    return Array.from({ length: panels.agents }, (_, slot) => {
        const kind = kinds ? kinds[slot % kinds.length]! : 'terminal';
        // A copy, not the table entry: the layout leaves this module and nothing
        // outside it should be able to redefine what `files` means for everyone.
        // The fallback is belt-and-braces — the validator refuses an unrecognised
        // kind — but returning `undefined` for one would crash the seeder, and a
        // GApp window that will not open is a worse answer than a terminal.
        const panel: PlannedPanel = { ...(PANEL_FOR_KIND[kind] ?? DEFAULT_PANEL) };
        if (!roster || panel.type !== 'terminal') return panel;

        const agent = roster[bound % roster.length]!;
        bound += 1;
        // The panel takes the agent's NAME. N panels all called "Terminal" is
        // what an app whose roster was never read looks like from the outside,
        // and the roster is the half the user was asked to consent to.
        return { ...panel, label: agent.name, agent };
    });
}

/**
 * The workspace this app's panels live in, as the seeder needs to see it.
 *
 * Bound to one workspace by whoever builds it, so nothing here has to carry a
 * workspace id around: which workspace an app has is an I/O question, and the
 * decision below does not depend on the answer.
 */
export interface AgentPanelIO {
    /** Panels the workspace already has. Background processes are not panels. */
    countPanels: () => number;
    createPanel: (panel: PlannedPanel) => void;
    /**
     * May this workspace start `n` more AGENT terminals (Tynn #117)?
     *
     * A GApp seeding a roster is exactly the fan-out the cap exists for — several
     * model sessions at once, each asking for the owner's attention, none of them
     * asked for one at a time — so its agents count like any others. Asked ONCE
     * for the whole batch rather than per slot, because the answer that matters is
     * "can the roster run", not "can one more".
     *
     * Optional: a seeder with no agents to start never needs it, and the preview
     * path and the fake in the unit suite both stand in for the real cap.
     */
    mayStartAgents?: (n: number) => { allowed: boolean; reason?: string };
}

export interface AgentPanelSeeding {
    /** The panels this call created — empty on every call after the first. */
    created: PlannedPanel[];
    /**
     * Why the app's agents did not start. Present ⇒ NOTHING was created, and the
     * caller owes the user this sentence.
     */
    refused?: string;
}

/**
 * Bring the workspace up to the layout the manifest declares, and no further.
 *
 * Returns what it created, which is empty on every call after the first — the
 * property that keeps opening an app ten times from leaving ten terminals behind.
 * Seeding RESUMES at the slot the workspace left off at rather than restarting, so
 * a palette still cycles correctly across an update that raised the count.
 *
 * It never removes anything. A manifest says what an app needs in order to work,
 * not what the person using it is allowed to have.
 *
 * A refusal is ALL-OR-NOTHING, for two reasons. Half a roster is the same silent
 * shortfall this whole change removes — the user consented to a NAMED set and
 * would quietly get fewer of them, with nothing said. And convergence depends on
 * it: the seeder resumes at `countPanels()`, so a partial seed that skipped an
 * earlier slot would leave that slot permanently unreachable, because every later
 * open slices straight past it.
 */
export function ensureAgentPanels(
    io: AgentPanelIO,
    panels: AppPanels,
    agents?: readonly AppAgentDecl[],
): AgentPanelSeeding {
    const missing = agentPanelLayout(panels, agents).slice(io.countPanels());

    const wanted = missing.filter((panel) => panel.agent).length;
    if (wanted > 0 && io.mayStartAgents) {
        const verdict = io.mayStartAgents(wanted);
        if (!verdict.allowed) {
            return {
                created: [],
                refused:
                    verdict.reason ??
                    'Genie did not start this app’s agents — the workspace is at its agent-terminal limit.',
            };
        }
    }

    for (const panel of missing) io.createPanel(panel);
    return { created: missing };
}
