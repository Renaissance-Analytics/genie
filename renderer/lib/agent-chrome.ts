import {
    restartOptionsFor,
    type AgentSpecLike,
    type RestartMode,
} from '../../main/agents/restart-options';

/**
 * The agent chrome, as decisions — shared by the grid tile and the Agent view header.
 *
 * Owner decision 2026-10-07, answering whether to delete `AgentPanel`: *"share the chrome
 * between both surfaces — note: we need terminal support but we don't need the TUI agent
 * support like we have it now. We do want to keep enough support that lets users open their
 * agent in a TUI terminal if needed but that is not the main ux."*
 *
 * `AgentPanel` was described in the Genie 2 plan as "~165 lines of indirection". It was not:
 * it carried five things, the Agent view had none of them, and it deliberately stripped the
 * shell switcher. Deleting it outright would have taken five features off the grid — which
 * #814 had just restored as a reachable surface — and handed agent tiles a control that can
 * turn a saved agent into an ordinary terminal.
 *
 * So the chrome moved here instead of dying, and came out leaner:
 *
 * - **No driver switcher.** It sat in the panel header AND in Agent settings → Driver. The
 *   manager's own note: the picker *"moved here rather than being duplicated — this is the
 *   one place in the manager that answers 'what is this agent running under, and is it
 *   running'"*. That tab is built on `decideTuiSwitch`, so it never offers a switch the host
 *   would refuse (genie#463). The header copy was the duplicate, and the duplicate is the
 *   one that could offer a refusal.
 * - **Terminal access kept** — the "if needed" half. The Agent view has a `terminal` tab and
 *   a grid tile IS the pty, so neither needs a control here.
 * - **Restart kept** (genie#443): lifecycle, not TUI apparatus.
 * - **Settings kept**, now the single route to driver and sidecar control.
 *
 * Decisions live in this module rather than in the components for the reason
 * `agent-manager.ts` already gives: the renderer has no DOM harness, so a decision left
 * inline in a `.tsx` is a decision nobody can assert on.
 */

/** What a surface renders in its header actions row, in order. */
export type AgentChromeControl =
    | {
          kind: 'screen-switch';
          label: string;
          name: string;
          target: 'sidecar' | 'driver';
          busy: boolean;
      }
    | { kind: 'restart'; mode: RestartMode; title: string };

/** What the context menu offers. */
export type AgentChromeMenuItem =
    | { kind: 'settings'; label: string }
    | { kind: 'restart-resume'; label: string; warns: false }
    | { kind: 'restart-fresh'; label: string; warns: boolean };

export interface AgentChromeInput {
    /** The terminal spec this surface is showing. */
    spec: AgentSpecLike | null | undefined;
    /** Whether the surface wired a restart handler. A control with none is a dead control. */
    onRestart: boolean;
    /** Whether the surface wired a settings handler. */
    onSettings: boolean;
    /**
     * Grid-tile navigation between an agent and its `<name>-slave` screen.
     *
     * An INPUT rather than something derived from the spec, because it is surface-specific:
     * the Agent view reaches a sidecar by route (`?agent=<id>`), so it supplies none.
     */
    screenSwitch?: {
        label: string;
        name: string;
        target: 'sidecar' | 'driver';
        busy: boolean;
    } | null;
}

/**
 * Which `TerminalPanel` surface an agent's terminal is rendered as.
 *
 * This is the safety property, and it is one prop: `TerminalPanel` does
 * `shells={surface === 'agent' ? [] : shellOptions}`, so an agent panel offers NO shells and
 * the switcher cannot quietly turn a saved agent into an ordinary terminal.
 *
 * `AgentPanel` guaranteed it by always passing `surface="agent"`. With it gone every caller
 * must, so the decision is shared from here instead of each surface remembering a prop.
 */
export function agentTerminalSurface(spec: AgentSpecLike | null | undefined): 'terminal' | 'agent' {
    return restartOptionsFor(spec).isAgent ? 'agent' : 'terminal';
}

/** The header controls for this surface, in render order. */
export function agentChromeControls(input: AgentChromeInput): AgentChromeControl[] {
    const options = restartOptionsFor(input.spec);
    const controls: AgentChromeControl[] = [];

    // FIRST, deliberately. It is the only control that can be `busy`, and a disabled control
    // that later re-enables must not shift the restart button under a waiting cursor.
    if (input.screenSwitch) {
        controls.push({ kind: 'screen-switch', ...input.screenSwitch });
    }

    if (options.isAgent && input.onRestart) {
        // The mode that PRESERVES THE MOST: resume when there is a conversation to keep,
        // fresh otherwise — so the control is never the button that only ever refuses, which
        // is what it was for every provider with no resume grammar (genie#443).
        const mode: RestartMode = options.canResume ? 'resume' : 'fresh';
        controls.push({
            kind: 'restart',
            mode,
            title:
                mode === 'resume'
                    ? 'Restart agent (resume the conversation)'
                    : 'Restart agent (fresh — starts a new conversation)',
        });
    }
    return controls;
}

/**
 * The context-menu items, in order.
 *
 * Empty when the surface wired no handlers — so a surface with nothing to offer opens no
 * menu at all, rather than an empty popover.
 */
export function agentChromeMenu(input: AgentChromeInput): AgentChromeMenuItem[] {
    const options = restartOptionsFor(input.spec);
    const items: AgentChromeMenuItem[] = [];

    if (input.onSettings) items.push({ kind: 'settings', label: 'Agent settings…' });

    if (options.isAgent && input.onRestart) {
        if (options.canResume) {
            items.push({ kind: 'restart-resume', label: 'Restart agent (resume)', warns: false });
        }
        if (options.canRestartFresh) {
            items.push({
                kind: 'restart-fresh',
                label: 'Restart agent (fresh)',
                // Warn only when Genie actually holds a session id, i.e. there is genuinely
                // something to lose. Warning when there is nothing to lose trains people to
                // ignore the warning.
                warns: options.losesConversation,
            });
        }
    }
    return items;
}
