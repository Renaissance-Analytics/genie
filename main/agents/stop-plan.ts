/**
 * STOPPING an agent, as a decision — genie#474.
 *
 * The renderer had no stop-an-agent path at all. What it had was `agents:delete`,
 * which tears the record down: a different verb with a different consequence, and
 * wiring a Stop button to it would be a control that does something other than
 * what it says, on a surface whose whole purpose is recovering agents you did not
 * mean to lose.
 *
 * A stop ENDS THE RUN AND KEEPS THE AGENT — the same distinction
 * `agent-manager.ts` already draws for the sidecar, where *"starting it again is
 * the same agent"*. Its identity, its `AGENT.md`, its inbox and its history are
 * untouched, and `start` brings it back.
 *
 * That promise is what this module makes structural rather than aspirational: a
 * plan can only ever NAME TERMINALS. There is no outcome here that removes a
 * row, a file or an inbox, so a Stop wired to this cannot drift into a Delete
 * however the executor is edited later.
 *
 * A terminal that is already gone is left OUT of the plan rather than killed
 * harmlessly. A dormant runtime keeps its `terminal_spec_id` binding, so its id
 * is still handed in; reporting it as stopped would be a claim about the machine
 * that is not true.
 *
 * PURE, like `tui-switch.ts` beside it: no db, no electron. The caller performs
 * whatever this returns. ZERO IMPORTS, so the renderer may share it if it ever
 * needs to (see `renderer/lib/__tests__/renderer-main-boundary.test.ts`).
 */

export type AgentStopPlan =
    /** Kill exactly these. Nothing else is touched. */
    | { kind: 'stop'; terminalIds: string[] }
    /** Nothing of this agent is up. Refusing beats reporting a stop that was
     *  never needed — a button that always "succeeds" says nothing. */
    | { kind: 'refuse'; reason: string };

export function planAgentStop(input: {
    name: string;
    /** Every terminal a stop would kill — `terminalsToStopFor`'s answer, which
     *  is the agent's own binding, every runtime it holds, and its sidecars. */
    terminals: readonly string[];
    /** Which of them is actually alive. */
    live: (terminalId: string) => boolean;
}): AgentStopPlan {
    const terminalIds = input.terminals.filter((id) => input.live(id));
    if (terminalIds.length === 0) {
        return { kind: 'refuse', reason: `${input.name} is not running.` };
    }
    return { kind: 'stop', terminalIds };
}
