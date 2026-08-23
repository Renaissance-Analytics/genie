/**
 * PURE. WHICH AI TUI a GApp's declared agents run under, and how a persona
 * reaches it (genie#245).
 *
 * The owner's model, verbatim: ".agents are folders that a genie terminal opens
 * claude or codex or whatever tui that user has set as their GApp AI Provider on
 * the workstation." So a GApp agent is not a new runtime — it is the one Genie
 * already has: a terminal, a coding-agent CLI, and a persona to run against.
 *
 * The rule that makes this a settings question at all: **the GApp does not
 * choose.** A GApp declares that it needs an agent; the WORKSTATION decides what
 * that agent is. Same reasoning as the agent-terminal cap — the app is spending
 * someone else's compute and someone else's subscription, so the person paying
 * picks the provider. Nothing in a manifest can override it, which is why the
 * provider is never a parameter to any of this: it is read from settings.
 *
 * Pure so both halves are assertable without a database, a shell or a TUI.
 */

import path from 'path';
import { APP_AGENTS_DIR } from './manifest';

/** The AI TUIs Genie can launch. Mirrors the agent types the rest of Genie knows. */
export const GAPP_PROVIDERS = ['claude', 'codex', 'custom'] as const;

export type GappProvider = (typeof GAPP_PROVIDERS)[number];

function known(value: unknown): value is GappProvider {
    return typeof value === 'string' && (GAPP_PROVIDERS as readonly string[]).includes(value);
}

/**
 * The provider a GApp's agents launch under.
 *
 * Three levels, and the order is the point:
 *
 *  1. `gapp_ai_provider` — the workstation's explicit answer to THIS question.
 *  2. `agent_default` — the agent the user already picked in Workstation Setup.
 *     Inherited rather than asked again: making somebody configure the same thing
 *     twice is how the second copy ends up stale and wrong.
 *  3. `claude` — a real answer, never `null`. An unresolvable provider means a
 *     declared agent silently does not launch, which is the bug being fixed.
 *
 * Values arrive from a k/v text table, so an unrecognised one falls THROUGH to
 * the next level rather than being handed to a shell.
 */
export function resolveGappProvider(settings: {
    gapp_ai_provider?: string;
    agent_default?: string;
}): GappProvider {
    if (known(settings.gapp_ai_provider)) return settings.gapp_ai_provider;
    if (known(settings.agent_default)) return settings.agent_default;
    return 'claude';
}

/**
 * Where a declared persona lives once the app is installed.
 *
 * `.agents/` is ENVELOPE-owned — beside `repos/` — so it is resolved against the
 * workspace ROOT and never through a component folder. The manifest validator has
 * already refused any persona path that could climb out of it (`isPersonaPath`),
 * which is what makes joining it here safe.
 */
export function gappPersonaPath(workspaceRoot: string, persona: string): string {
    return path.join(workspaceRoot, APP_AGENTS_DIR, ...persona.split('/'));
}

/**
 * Everything a double-quoted shell argument cannot survive.
 *
 * The briefing is assembled from a manifest-declared NAME and a path on the
 * user's disk, so neither is trusted, and this line is TYPED INTO A LIVE SHELL —
 * whichever one the user has set, on whichever OS. So the strip covers what is
 * special inside double quotes across all of them, not just the one this machine
 * happens to run:
 *
 *  - `"` closes the argument and turns the rest of the briefing into shell words.
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
 * Mangling prose is the right trade. The briefing is instructions, not data, and
 * the alternative — a launch line that a shell parses differently than Genie
 * meant — is the failure this whole change exists to remove, wearing a shell's
 * clothes.
 */
function quotable(value: string): string {
    return value
        .replace(/\\/g, '/')
        .replace(/["`$!%\r\n]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * Point a launching TUI at the persona it is supposed to BE.
 *
 * A first prompt rather than a provider-specific system-prompt flag: every TUI
 * Genie launches takes an opening prompt positionally, and the workstation — not
 * Genie — chooses which TUI that is, so anything claude-shaped would break the
 * moment somebody set the provider to codex. The persona is named by PATH rather
 * than inlined, so the agent reads the file the app actually ships (personas are
 * often more than one file, and the folder travels whole).
 *
 * Appended before `renderAgentLaunch` adds its session flag, giving
 * `<command> <flags> "<briefing>" --session-id <uuid>`.
 */
export function withPersonaBriefing(command: string, personaPath: string, name: string): string {
    // No inner quoting of ANY kind — not even around the agent's name. The whole
    // briefing is one double-quoted argument, so a `"` inside it closes that
    // argument and hands the remainder to the shell as words.
    const briefing =
        `You are ${quotable(name)}, an agent this Genie App ships. ` +
        `Read ${quotable(personaPath)} — it is your persona — and work as it describes ` +
        'for this whole session.';
    return `${command.trim()} "${briefing}"`.trim();
}
