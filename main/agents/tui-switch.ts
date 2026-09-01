/**
 * Switching the TUI an agent runs under.
 *
 * An agent is not its TUI. `claude` and `codex` are drivers it can move between,
 * and the driver it moves AWAY from keeps its pty and its conversation as a
 * hidden sidecar to flip back to. That is what makes switching acceptable at
 * all: a Claude transcript means nothing to Codex, so conversation continuity is
 * per-TUI by nature. The agent's IDENTITY — its `agent_id`, its inbox, its name,
 * its prompt — carries across; each TUI keeps its own thread to return to.
 *
 * THE OWNER'S RULE: never kill or stop without confirmation. So this decision
 * has no "stop" outcome at all — it can front an existing runtime or create one,
 * and it can never end another. Anything that costs a live process is a
 * separate, confirmed action. Keeping the decision pure and enumerable is what
 * makes that auditable rather than something a reader has to trace through side
 * effects to be sure of.
 *
 * PURE: no db, no electron. The caller performs whatever it returns.
 */

export interface SwitchRuntime {
    id: string;
    tui: string;
    terminalSpecId: string | null;
    fronted: boolean;
}

export type TuiSwitchDecision =
    /** Already the visible TUI — harmless, and NOT a relaunch. */
    | { kind: 'already'; runtimeId: string }
    /** The agent already holds this TUI: flip to it. Nothing starts, nothing stops. */
    | { kind: 'front'; runtimeId: string }
    /** The agent has never run this TUI: start one and front it. */
    | { kind: 'create'; tui: string }
    /** The agent's own file does not list this TUI. */
    | { kind: 'refuse'; reason: string };

export function decideTuiSwitch(input: {
    runtimes: readonly SwitchRuntime[];
    to: string;
    /** `tuis` from the agent's AGENT.md. EMPTY means "no opinion", not "none". */
    allowed: readonly string[];
}): TuiSwitchDecision {
    const { runtimes, to, allowed } = input;

    // An empty `tuis` is the file's default, so reading it as a lockout would
    // make every agent unswitchable until someone edited a file they never saw.
    // A non-empty list IS the author's statement of which drivers this agent is
    // written for, and a prompt tuned for one harness is not automatically safe
    // on another.
    if (allowed.length > 0 && !allowed.includes(to)) {
        return {
            kind: 'refuse',
            reason:
                `This agent does not list "${to}" among the TUIs it runs under ` +
                `(${allowed.join(', ')}). Add it to \`tuis\` in the agent's AGENT.md first.`,
        };
    }

    // Match on PROVIDER, not on having a live terminal: a sidecar whose pty
    // exited is still this agent's conversation on that TUI, and creating a
    // second runtime beside it would strand the thread and trip the
    // one-runtime-per-TUI rule.
    const existing = runtimes.find((r) => r.tui === to);
    if (existing) {
        return existing.fronted
            ? { kind: 'already', runtimeId: existing.id }
            : { kind: 'front', runtimeId: existing.id };
    }
    return { kind: 'create', tui: to };
}
