import { engineFor, type AgentEngine } from './engine';
import { withStartupInstructions } from './startup';

/**
 * What starting an agent MEANS, for each engine.
 *
 * The pure half of the one branch in `createAgentTerminal` — the single chokepoint every
 * launch path bottoms out in, by design: a renderer click, `runAgent start`, mobile,
 * revival. Its own comment explains why it is the chokepoint ("owning the launch here
 * means no entry point can create an agent terminal that never starts"), and that is
 * exactly why the ACP branch belongs there and nowhere else.
 *
 * It lives in a 115 KB file that imports electron and the database and ships with no test,
 * so the decision is here and the file gets two lines.
 */
/**
 * THERE IS NO PTY PLAN. An agent runs as a structured session or it does not run.
 *
 * `kind` is a single member on purpose rather than a bare object: it keeps every existing
 * `plan.kind === 'acp'` call site valid, and a future second engine has somewhere to go.
 * What it must never regain is a terminal.
 */
export type LaunchPlan = {
    kind: 'acp';
    provider: string;
    /**
     * The configured launch line ACP cannot carry, when there was one.
     *
     * ACP adapters take bare argv and everything else travels in the environment, so flags
     * on a stored `agent_command` are genuinely lost. They used to be "kept" by routing the
     * agent to a pty, which traded a visible loss for an invisible one — a terminal. Now the
     * loss is reported so a caller can show it, and `null` means nothing was dropped.
     */
    droppedCommand: string | null;
};

export interface LaunchPlanInput {
    provider: string | null;
    /** The TUI launch line, when there is one. */
    command: string | null;
    agentOverride?: AgentEngine;
    /**
     * The startup instructions the caller is ALSO handing to the engine.
     *
     * Needed because `withStartupInstructions` folds them into the launch line as a quoted
     * positional argument, which by shape is indistinguishable from a user's own quoted
     * value. Knowing the text is what makes Genie's own addition identifiable — and ACP
     * delivers it as the session's first prompt, so stripping it loses nothing.
     */
    instructions?: string | null;
}

/**
 * GENIE'S OWN additions to a launch line, each of which ACP replaces rather than loses.
 *
 * Enumerated, not guessed. Every one of these is written by Genie two files away, and the
 * question this list answers is "would starting an ACP session DROP something?" — so anything
 * NOT on it holds the agent on the pty, which is the safe direction: the pty honours it
 * exactly as today.
 *
 *  - `--session-id <id>` — `renderAgentLaunch` mints it. ACP supersedes it: the provider
 *    reports its own id over the wire (`META_CLI_SESSION_ID`).
 *  - `--dangerously-load-development-channels server:genie-agentinbox-channel` —
 *    `withClaudeAgentInboxChannelLaunch` appends it so the agent has a mail transport. An ACP
 *    session IS one, and a push rather than a pull (`main/acp/mail-transport.ts`).
 *  - the trailing instructions argument — see {@link withoutGenieInstructions}.
 *
 * What is deliberately NOT here: `resolveProviderFlags`, which is Settings → provider flags.
 * That is the owner's configuration, it has no ACP equivalent, and dropping it silently would
 * start an agent that answers while not being the agent that was configured.
 */
const GENIE_SESSION_FLAG = /\s*--session-id(?:=|\s+)\S+/g;
/** Matched by SHAPE rather than imported, so this file stays free of `mcp/agent-config` and its
 *  filesystem reads. `launch-plan.test.ts` asserts the real flag that module writes. */
const GENIE_CHANNEL_FLAG = /\s*--dangerously-load-development-channels\s+server:\S+/g;

/**
 * Is this launch line nothing but the provider's own binary?
 *
 * The question behind it: would starting an ACP session DROP something the command carries?
 * ACP spawns the adapter with bare argv and passes everything else in the environment, so a
 * command line reaches it in no form at all — `claude --model opus`, a wrapper, a different
 * binary. Those have to stay on the pty, which honours them exactly as before.
 *
 * `--session-id <uuid>` is excluded because Genie appended it itself (`renderAgentLaunch`),
 * and ACP supersedes it: the provider reports its own id over the wire. Counting it would
 * hold EVERY claude agent on the pty and make ACP unreachable — while the suite stayed green,
 * because the pty path works.
 *
 * `.exe` and surrounding whitespace are accepted: that is how Windows renders the binary, and
 * Windows is where this runs.
 */
function isBareProviderCommand(
    provider: string,
    command: string,
    instructions?: string | null,
): boolean {
    const withoutFlag = command.replace(GENIE_SESSION_FLAG, '').replace(GENIE_CHANNEL_FLAG, '');
    const bare = withoutGenieInstructions(withoutFlag, instructions).trim().toLowerCase();
    if (!bare) return true;
    return bare === provider.toLowerCase() || bare === `${provider.toLowerCase()}.exe`;
}

/**
 * Remove the trailing instructions argument IF it is the one we were handed.
 *
 * Rendered through `withStartupInstructions` rather than matched by a regex, so this cannot
 * drift from the quoting the launch line actually used — the same reason `withPersonaBriefing`
 * delegates to `personaBriefing` instead of repeating the sentence. The `--` form is codex's
 * separator from `withProviderStartupInstructions`.
 *
 * A quoted argument we were NOT told about is left in place, and holds the agent on the pty:
 * it is someone's own prompt or filename, and ACP has no way to carry it.
 */
function withoutGenieInstructions(command: string, instructions?: string | null): string {
    const rendered = instructions ? withStartupInstructions('', instructions) : '';
    if (!rendered) return command;
    const trimmed = command.trim();
    for (const suffix of [`-- ${rendered}`, rendered]) {
        if (trimmed.endsWith(suffix)) return trimmed.slice(0, -suffix.length).trim();
    }
    return command;
}

export function launchPlan(input: LaunchPlanInput): LaunchPlan | null {
    const engine = engineFor({
        provider: input.provider,
        agentOverride: input.agentOverride,
    });

    // No engine means the provider cannot speak ACP, and there is nowhere else for an agent
    // to go. REFUSE — `null` is "not runnable as an agent", and the caller has to say so.
    // It must not open a terminal, which is what the old fallthrough did.
    if (engine === null || !input.provider) return null;

    // ACP does not use the launch line at all — the adapter is spawned with bare argv and
    // everything travels in the environment — so a missing command was never a reason to
    // refuse here.
    //
    // A CONFIGURED command used to hold its agent on the pty, on the reasoning that ACP
    // drops the line silently and the agent would "come up answering, but not as the agent
    // that was configured". That is a real cost, but the price it paid was a terminal, and
    // the owner's 30 agents all carry flags — so every one of them was routed to a pty while
    // `claude` was ACP-capable the whole time. The loss is now REPORTED instead of avoided.
    const dropped =
        input.command && !isBareProviderCommand(input.provider, input.command, input.instructions)
            ? input.command
            : null;

    return { kind: 'acp', provider: input.provider, droppedCommand: dropped };
}
