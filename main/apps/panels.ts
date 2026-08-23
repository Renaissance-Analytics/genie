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

import type { AppPanels } from './manifest';

/** One panel to lay out: the Genie view that renders it, and what to call it. */
export interface PlannedPanel {
    label: string;
    /** A Genie view type. `code` is the tree-and-editor panel. */
    type: 'terminal' | 'code';
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
 */
export function agentPanelLayout(panels: AppPanels): PlannedPanel[] {
    const kinds = panels.kinds?.length ? panels.kinds : null;
    return Array.from({ length: panels.agents }, (_, slot) => {
        const kind = kinds ? kinds[slot % kinds.length]! : 'terminal';
        // A copy, not the table entry: the layout leaves this module and nothing
        // outside it should be able to redefine what `files` means for everyone.
        // The fallback is belt-and-braces — the validator refuses an unrecognised
        // kind — but returning `undefined` for one would crash the seeder, and a
        // GApp window that will not open is a worse answer than a terminal.
        return { ...(PANEL_FOR_KIND[kind] ?? DEFAULT_PANEL) };
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
 */
export function ensureAgentPanels(io: AgentPanelIO, panels: AppPanels): PlannedPanel[] {
    const missing = agentPanelLayout(panels).slice(io.countPanels());
    for (const panel of missing) io.createPanel(panel);
    return missing;
}
