/**
 * Who a list belongs to, and what an unfinished one says on the way out.
 *
 * Pure — no db, no broker, no Electron. Both questions here are decisions
 * rather than I/O, and both are ones the feature can get wrong invisibly: a
 * list quietly filed under the wrong owner reads exactly like an empty list,
 * and a summary line that renders for an agent with nothing to say turns every
 * `imDone` in the workspace into noise.
 */

/** The identity a list hangs off: a workspace, and an agent NAME within it. */
export type ListOwner =
    | { ok: true; workspaceId: string; agentName: string }
    | { ok: false; reason: string };

/**
 * Resolve the caller's terminal to the agent whose list it is.
 *
 * Keyed on the agent NAME, deliberately, and this is not a free choice — it is
 * the rule `main/agents/handoff.ts` already established for the note an agent
 * leaves for its own next run:
 *
 *   "One file per AGENT NAME, not per terminal: a terminal id changes every
 *    restart, which is exactly the identity that fails to carry across the gap
 *    the handoff exists to bridge."
 *
 * An AgentList makes the same promise — "always there until it clears" — so it
 * spans the same gap and needs the same key. The two other ids on offer both
 * fail it: `workspace_agents.id` exists only for an agent that called
 * `registerAgent`, and the AgentInbox agent id is re-minted by `spawnTerminal`
 * on every launch.
 *
 * Every refusal here is real and is reported as a sentence, because each one
 * means the caller gets no list at all and needs to know which fact was missing.
 */
export function planListOwner(spec: {
    workspace_id: string | null;
    meta?: { whisper_purpose?: unknown } | null;
}): ListOwner {
    if (!spec.workspace_id) {
        return {
            ok: false,
            reason: 'this terminal is not attached to a Genie workspace, and a list is scoped to one',
        };
    }
    const agentName = String(spec.meta?.whisper_purpose ?? '').trim();
    if (!agentName) {
        return {
            ok: false,
            reason: 'this terminal has no agent name, and a list is filed under the agent name (a terminal id changes on every restart, so it cannot be the identity)',
        };
    }
    return { ok: true, workspaceId: spec.workspace_id, agentName };
}

/**
 * The terminal a nudge for this agent should go to right now, or null.
 *
 * Null is an ordinary answer, not an error: the agent that asked for something
 * may have finished, been killed, or been relaunched into a terminal that has
 * since closed. The caller has to say so out loud rather than report a delivery
 * — a nudge that goes nowhere while the UI shows a tick is the exact failure
 * this feature exists to prevent.
 */
export function liveTerminalForAgent(
    terminals: readonly {
        id: string;
        workspace_id: string | null;
        meta?: { whisper_purpose?: unknown } | null;
    }[],
    isLive: (terminalId: string) => boolean,
    workspaceId: string,
    agentName: string,
): string | null {
    const match = terminals.find(
        (t) =>
            t.workspace_id === workspaceId &&
            String(t.meta?.whisper_purpose ?? '').trim() === agentName &&
            isLive(t.id),
    );
    return match?.id ?? null;
}

/**
 * The AgentList line appended to the `imDone` response, or null for an empty
 * list.
 *
 * Null rather than an empty string: `imDone` composes its extras with
 * `.filter(Boolean)`, so returning null is what makes an agent that keeps no
 * list pay nothing for the feature.
 */
export function agentListSummary(items: readonly { text: string }[]): string | null {
    if (items.length === 0) return null;
    const noun = items.length === 1 ? '1 item' : `${items.length} items`;
    const lines = items.map((i) => `  - ${i.text}`).join('\n');
    return `Your AgentList still has ${noun} open:\n${lines}`;
}
