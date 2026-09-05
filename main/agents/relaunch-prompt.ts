/**
 * What an agent is told when it comes BACK — genie#434.
 *
 * `boot-prompt.ts` orients an agent at its FIRST launch. Every relaunch — the
 * restart button, a revive of a saved agent whose pty died, the drain restore
 * after an upgrade — composed nothing of its own. At best it replayed the
 * agent's stored launch instructions verbatim, which is a snapshot of a
 * different moment: it was only written by some of the create paths, only since
 * #302, and it says nothing whatever about the restart. For everything else a
 * bare resume line was typed and that was the whole of it.
 *
 * So the agent came back and simply carried on, and the two things a relaunch
 * genuinely changes went unsaid:
 *
 *  1. **The Genie channel is gone.** The MCP endpoint is registered per
 *     TERMINAL and dies with the pty; the relaunch gets a fresh one. A resumed
 *     conversation still holds the old connection in its context and has no way
 *     to know it is dead, so it discovers the loss on its next tool call — or
 *     never, and simply stops reaching the user.
 *  2. **Nobody can tell whether it worked.** `restartAgentTerminal` is careful
 *     to report `relaunching` rather than `restarted` because it cannot see
 *     inside the pty (genie#364). A `thumbsUp` is the signal it lacks — and it
 *     costs the agent one call.
 *
 * This is the RELAUNCH half of that pair, and it is separate from the boot
 * prompt on purpose: the boot prompt is what is true of the AGENT, this is what
 * is true of THIS LAUNCH. Conflating them is what put a restart's orientation
 * into a durable spec field, where it either goes stale or compounds.
 *
 * ★ NO `"` `` ` `` `$` `!` `%` OR NEWLINE-DEPENDENT LAYOUT. This text is
 * delivered as ONE double-quoted argv element on a shell command line, and
 * `startup.ts`'s `quotable` STRIPS those characters rather than escaping them —
 * so markdown backticks around a tool name would arrive with the name pulled
 * apart, and the tool names ARE the instruction here.
 */

export interface AgentRelaunchContext {
    /** True once the workspace can actually serve the genie MCP tools. */
    genieAvailable: boolean;
    /**
     * Did this relaunch RE-ENTER the previous conversation?
     *
     * The two cases need different words and the difference is not cosmetic. A
     * resumed agent already holds its context and must be told to carry on, or
     * it reads the prompt as a fresh brief and redoes work. An agent whose
     * conversation could not be resumed holds nothing, and telling it to "pick
     * up where you left off" names a place it cannot see.
     */
    resumed: boolean;
    /**
     * The agent's STANDING launch instructions (`meta.agent_instructions`), when
     * it has any. Carried through unchanged: they are still true of the agent,
     * and for the workstation operator they are the role brief and the boot
     * script it must not come back without.
     */
    saved?: string | null;
}

/**
 * The relaunch line itself.
 *
 * `thumbsUp`'s reason is `boot` because that is a reason the tool ACCEPTS —
 * its enum is boot / ack / shutdown, and anything else is silently coerced to
 * `ack`. A prompt asking for a `restart` reason would produce a signal that does
 * not mean what the prompt said it meant, which is worse than asking for
 * nothing.
 */
function relaunchLine(resumed: boolean): string {
    const opening = resumed
        ? 'Genie just RESTARTED you. Your conversation was resumed, so you still have your ' +
          'context — but the terminal it was running in is gone, and your connection to Genie ' +
          'went with it. This is a new terminal with a new MCP endpoint.'
        : 'Genie just RESTARTED you, and your previous conversation could not be resumed — ' +
          'this is a fresh session in a new terminal.';
    const ask =
        'Before anything else, call connectToGenie to re-establish the channel, then call ' +
        'thumbsUp with reason boot so the restart is confirmed rather than assumed. ' +
        'Genie can see that the process relaunched; it cannot see that you are working.';
    return resumed
        ? `${opening} ${ask} Then pick up where you left off.`
        : `${opening} ${ask}`;
}

/**
 * PURE. What to deliver into a relaunched agent's fresh pty.
 *
 * Gated on Genie for the same reason every line of the boot prompt is: naming
 * `connectToGenie` and `thumbsUp` to an agent that has no way to call them is
 * the boot prompt's own definition of a lie, and a restart is not an exception
 * to it. With no Genie the standing instructions are all there is to say, and
 * they pass through unchanged — the behaviour before this existed.
 *
 * The relaunch line comes FIRST. It is about this launch, and standing
 * instructions routinely open with "read this before starting anything" — an
 * order that would put the reconnect behind whatever that turns out to be.
 */
export function agentRelaunchPrompt(ctx: AgentRelaunchContext): string {
    const saved = ctx.saved?.trim();
    if (!ctx.genieAvailable) return saved ?? '';
    return [relaunchLine(ctx.resumed), ...(saved ? [saved] : [])].join('\n\n');
}
