/**
 * PURE. STARTING an agent is per-harness, and may carry instructions (Tynn #254).
 *
 * Two things live here, and they are separate on purpose.
 *
 * ## 1. Pre-loaded instructions
 *
 * An agent may start with a prompt already delivered — not typed afterwards by
 * whoever remembers to. Every TUI Genie launches takes an opening prompt
 * POSITIONALLY, which is why this is one line appended to the command rather
 * than a per-provider system-prompt flag: the workstation chooses the harness,
 * so anything claude-shaped breaks the moment somebody picks codex.
 *
 * This is the generalisation of the GApp persona briefing (genie#245), which was
 * the same mechanism with the text hard-coded. {@link withPersonaBriefing} is now
 * a caller of it, so the shell-quoting below is the only copy.
 *
 * ## 2. When the chat-id becomes knowable — THE CODEX CONSTRAINT
 *
 * Claude is told its session id at launch (`--session-id <uuid>`), so its ref is
 * complete before the process exists. **Codex cannot be.** Its session id is
 * minted by the harness and only revealed when SessionStart fires, so any design
 * that needs `{provider}:{name}:{chat-id}` before spawning cannot start a Codex
 * agent at all.
 *
 * The resolution, and the seam Codex's own startup plan attaches to:
 *
 *   - a saved agent is keyed by `{provider}:{name}` — no chat-id (see
 *     `identity.ts` `savedAgentKey`), so it resolves before launch;
 *   - the durable identity is `terminal_specs.meta.agent_id`, minted by Genie
 *     when the agent is created and never re-minted;
 *   - the chat-id is bound DURING startup, onto that existing record, by
 *     `agentinbox/session-registration.ts` `registerAgentInboxSession` — which
 *     Genie's managed Codex SessionStart hook reaches via the AgentInbox
 *     `registerSession` action. It updates `meta.chat_session_id` and the live
 *     broker record IN PLACE, so inbox cursors, queued mail, channel membership
 *     and DM history stay attached across the bind.
 *
 * {@link chatIdBinding} is the machine-readable form of that sentence. It is
 * DERIVED from the launch profiles rather than restated, so a harness that gains
 * a session flag cannot end up described two different ways.
 */

import { LAUNCH_PROFILES } from '../agentinbox/session-capture';
import type { AgentTui } from './identity';

/**
 * WHEN a harness's chat-id becomes knowable.
 *
 *  - `at-launch`  — Genie mints it and passes it in (claude's `--session-id`).
 *  - `after-launch` — only the running harness knows it. It arrives later, via
 *    `registerAgentInboxSession` (codex's SessionStart hook) or the transcript
 *    watcher (a custom wrapper). The saved agent must be startable WITHOUT it.
 */
export type ChatIdBinding = 'at-launch' | 'after-launch';

/**
 * The physical instruction entry points Genie gives a provider at launch.
 * Codex and Claude expand their managed root routers themselves. Providers
 * without a native root-file contract receive every relevant file explicitly.
 */
export function providerInstructionFiles(provider: AgentTui, workspacePath: string): string[] {
    const root = String(workspacePath ?? '').replace(/\\/g, '/').replace(/\/$/, '');
    if (provider === 'codex') return [`${root}/AGENTS.md`];
    if (provider === 'claude') return [`${root}/CLAUDE.md`];
    return [
        `${root}/README.md`,
        `${root}/RULES.md`,
        `${root}/.agents/_genie/shared.md`,
        `${root}/.agents/_genie/genie-${provider}.md`,
    ];
}

export function chatIdBinding(provider: AgentTui): ChatIdBinding {
    return LAUNCH_PROFILES[provider]?.strategy === 'flag' ? 'at-launch' : 'after-launch';
}

/**
 * Everything a double-quoted shell argument cannot survive.
 *
 * Instructions are assembled from a caller-supplied name and, for GApps, a path
 * on the user's disk — neither trusted — and the line is TYPED INTO A LIVE
 * SHELL, whichever one the user has set, on whichever OS. So the strip covers
 * what is special inside double quotes across all of them, not just the one this
 * machine happens to run:
 *
 *  - `"` closes the argument and turns the rest into shell words.
 *  - `` ` `` and `$` substitute in bash/zsh AND PowerShell.
 *  - `!` history-expands in an INTERACTIVE bash — and a failed expansion rejects
 *    the whole line, so an agent named "Fix It!" would simply never launch.
 *  - `%` expands `%VAR%` in cmd.
 *  - Newlines would submit half a command.
 *
 * Backslashes become forward slashes rather than being stripped: a trailing one
 * escapes the closing quote, Windows paths are full of them, and every TUI opens
 * the file perfectly well either way.
 *
 * Mangling prose is the right trade. Instructions are instructions, not data,
 * and the alternative — a launch line a shell parses differently than Genie
 * meant — is a failure wearing a shell's clothes.
 */
export function quotable(value: string): string {
    return String(value ?? '')
        .replace(/\\/g, '/')
        .replace(/["`$!%\r\n]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * A prompt may not LOOK LIKE AN OPTION.
 *
 * The instructions become one argv element handed to the harness's option
 * parser, and an element beginning with `-` is ambiguous to every one of them:
 * at best the CLI rejects an unknown flag and the agent never starts, at worst
 * it consumes the prompt as one. Genie's launch line does not yet carry an
 * explicit end-of-options `--` separator — that is provider-aware launch grammar
 * being built alongside the Codex harness-startup work — so until it does, the
 * prompt itself must not be option-shaped.
 *
 * Stripping rather than escaping, for the same reason as {@link quotable}: prose
 * never legitimately begins with a dash, and "read the file" surviving as
 * instructions beats a launch line the parser reads differently than Genie
 * meant. It also stays correct once `--` arrives — a separator in front of a
 * prompt that is not option-shaped is belt and braces, not a conflict.
 */
function notOptionShaped(text: string): string {
    return text.replace(/^-+\s*/, '').trim();
}

/**
 * Append PRE-LOADED INSTRUCTIONS to a launch command — the agent starts with
 * this prompt already delivered.
 *
 * One double-quoted argument, with no inner quoting of any kind: a `"` inside it
 * would close the argument and hand the remainder to the shell as words, which
 * is why {@link quotable} strips rather than escapes. The result is additionally
 * kept from looking like an option (see {@link notOptionShaped}).
 *
 * This low-level helper only sanitizes and quotes. Provider launch code uses
 * {@link withProviderStartupInstructions} after composing every option.
 *
 * Empty/whitespace instructions are a no-op, so a caller can pass through an
 * optional field without branching. Instructions that were NOTHING but dashes
 * are the same no-op rather than an empty `""` argument, which some parsers
 * accept as a real (blank) prompt.
 */
export function withStartupInstructions(command: string, instructions: string): string {
    const text = notOptionShaped(quotable(instructions));
    if (!text) return String(command ?? '').trim();
    return `${String(command ?? '').trim()} "${text}"`.trim();
}

/** Apply the harness's argv grammar after every launch option has been composed. */
export function withProviderStartupInstructions(
    provider: AgentTui,
    command: string,
    instructions: string,
): string {
    const rendered = withStartupInstructions('', instructions);
    if (!rendered) return String(command ?? '').trim();
    return `${String(command ?? '').trim()}${provider === 'codex' ? ' --' : ''} ${rendered}`.trim();
}

/**
 * Point a launching TUI at the persona it is supposed to BE — the GApp flavour
 * of {@link withStartupInstructions} (genie#245).
 *
 * The persona is named by PATH rather than inlined, because personas are often
 * more than one file and the folder travels whole.
 */
export function withPersonaBriefing(command: string, personaPath: string, name: string): string {
    return withStartupInstructions(
        command,
        `You are ${name}, an agent this Genie App ships. ` +
            `Read ${personaPath} — it is your persona — and work as it describes ` +
            'for this whole session.',
    );
}
