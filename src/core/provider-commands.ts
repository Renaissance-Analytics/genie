/**
 * WHAT THE AGENT'S OWN CLI CAN RUN — its slash commands, its skills, and the plugins and subagents behind them.
 *
 * The owner (2026-10-14): "All agents that have the ability to provide their own plugins and skills via their provider
 * cli need to surface those through the genie chat and agent settings (read only)."
 *
 * The provider reports them as ACP `available_commands_update` (prism-acp >= 0.13 maps Claude's `system/init` to one;
 * a provider that sends its own goes through unchanged). The latest report REPLACES the last. `null` = never reported,
 * which is not the same as an agent that offers none (`[]`).
 *
 * Running one is sending `/<name>` (and any arguments) as the prompt — the CLI runs it. Genie adds nothing between.
 */

/** prism-acp's `_meta` keys (its `META_COMMAND_SOURCE`, `META_PLUGINS`, `META_SUBAGENTS`), spelled here as the other META keys are. */
const COMMAND_SOURCE_META = 'particle.academy/command_source';
const PLUGINS_META = 'particle.academy/plugins';
const SUBAGENTS_META = 'particle.academy/subagents';

export interface ProviderCommand {
    /** Without the leading slash, as ACP names it. */
    readonly name: string;
    readonly description: string;
    /** `command` or `skill` when the provider said; `null` when it did not. */
    readonly source: 'command' | 'skill' | null;
}

export interface ProviderPlugin {
    readonly name: string;
    readonly source: string | null;
    readonly version: string | null;
}

export interface ProviderExtensions {
    readonly commands: readonly ProviderCommand[];
    /** `null` = the provider did not report its plugins. */
    readonly plugins: readonly ProviderPlugin[] | null;
    /** `null` = the provider did not report its subagents. */
    readonly subagents: readonly string[] | null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
    return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | null {
    return typeof v === 'string' && v.length > 0 ? v : null;
}

/** The extensions an ACP update reports, or `null` when the update is not an `available_commands_update`. */
export function extensionsFrom(update: Record<string, unknown>): ProviderExtensions | null {
    if (update['sessionUpdate'] !== 'available_commands_update') return null;
    const raw = Array.isArray(update['availableCommands']) ? update['availableCommands'] : [];
    const seen = new Set<string>();
    const commands: ProviderCommand[] = [];
    for (const c of raw) {
        if (!isRecord(c)) continue;
        const name = str(c['name'])?.replace(/^\//, '') ?? null;
        if (!name || seen.has(name)) continue;
        seen.add(name);
        const source = isRecord(c['_meta']) ? c['_meta'][COMMAND_SOURCE_META] : undefined;
        commands.push({ name, description: str(c['description']) ?? '', source: source === 'command' || source === 'skill' ? source : null });
    }
    const meta = isRecord(update['_meta']) ? update['_meta'] : {};
    const plugins = Array.isArray(meta[PLUGINS_META])
        ? (meta[PLUGINS_META] as unknown[]).filter(isRecord).flatMap((p) => {
              const name = str(p['name']);
              return name ? [{ name, source: str(p['source']), version: str(p['version']) }] : [];
          })
        : null;
    const subagents = Array.isArray(meta[SUBAGENTS_META])
        ? (meta[SUBAGENTS_META] as unknown[]).filter((s): s is string => typeof s === 'string' && s.length > 0)
        : null;
    return { commands, plugins, subagents };
}

/** The composer's `/` menu entries (react-fancy's `PromptCmd`: names start with `/`). */
export function toPromptCmds(commands: readonly ProviderCommand[] | null | undefined): { name: string; hint: string }[] {
    return (commands ?? []).map((c) => ({ name: `/${c.name}`, hint: c.description }));
}
