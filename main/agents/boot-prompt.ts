/**
 * What an agent is told at launch.
 *
 * It used to be a reading list:
 *
 *     Before doing work, read and follow these instruction files in order:
 *     <workspace>/AGENTS.md, <workspace>/CLAUDE.md, ...
 *
 * which is the wrong instrument. Those files are already the agent's system
 * prompt — `AGENTS.md`/`CLAUDE.md` are routers of `@` imports the harness
 * expands before the agent reads a word. Telling it to go and read them again
 * spends the opening of every session re-fetching what it was already given,
 * and says nothing about the three things it actually cannot know by itself:
 * whether it is connected to Genie, what the previous run of this agent was
 * doing, and what the project expects of it.
 *
 * So the boot prompt orients instead of reciting:
 *
 *   1. connect to Genie — the one channel back to the human,
 *   2. pick up the handoff the previous run left, if there is one,
 *   3. get the lay of the land from Tynn, when the workspace is linked to it.
 *
 * Each line is only emitted when the thing it names actually exists. A prompt
 * that tells an agent to read a handoff that was never written, or to consult a
 * Tynn project the workspace is not linked to, is the same lie as a menu item
 * that does nothing — it costs the agent a call and a wrong belief.
 */

export interface AgentBootContext {
    /** True once the workspace can actually serve the genie MCP tools. */
    genieAvailable: boolean;
    /** The previous run's note, if one was left. */
    handoffPath?: string | null;
    /** Set when this workspace is linked to a Tynn project. */
    tynnLinked?: boolean;
    /** A specialized agent's own persona file, when it has one. */
    personaPath?: string | null;
    /** Anything the caller wants appended verbatim (runAgent `instructions`). */
    extra?: string | null;
}

export function agentBootPrompt(ctx: AgentBootContext): string {
    const lines: string[] = [];

    if (ctx.genieAvailable) {
        lines.push(
            'Start by calling `connectToGenie` — it orients you in this workspace and is your only channel back to the user. ' +
                'Nothing you print in this terminal is read by anyone.',
        );
    }

    // ALWAYS ask for one; only mention READING one when there is one to read.
    // Until this split, only an agent that already received a handoff was told
    // to leave one — so the first run of every agent learned nothing and left
    // nothing, and the next run again found nothing. The protocol never got off
    // the ground on its own.
    if (ctx.handoffPath) {
        lines.push(
            `A previous run of this agent left a handoff at ${ctx.handoffPath} — read it before starting anything, ` +
                'and leave your own by passing `handoff` to `imDone` when you stop.',
        );
    } else if (ctx.genieAvailable) {
        // `imDone` is a genie MCP tool. With no Genie there is nothing to call,
        // and asking would send the agent after a tool it does not have.
        lines.push(
            'When you stop, leave a handoff for whoever picks this agent up next by passing `handoff` to `imDone` — ' +
                'what you were in the middle of, and anything the next run cannot work out from the repo on its own.',
        );
    }

    if (ctx.tynnLinked) {
        lines.push(
            'This workspace is linked to a Tynn project. Use the `tynn` MCP tools to see the current work, ' +
                'what is assigned to you, and what is already claimed — before deciding what to do.',
        );
    }

    if (ctx.personaPath) {
        lines.push(`Adopt your specialized persona from ${ctx.personaPath}.`);
    }

    const extra = ctx.extra?.trim();
    if (extra) lines.push(extra);

    return lines.join('\n\n');
}
