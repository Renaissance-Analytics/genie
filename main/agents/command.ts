/**
 * PURE. A provider's base command and always-on flags, resolved from the
 * registry plus the owner's settings (genie#261).
 *
 * This was an `if`/`else` ladder in `host-tools.ts` that spelled every provider
 * out TWICE — once as a settings key, once as a fallback default — and a nested
 * ternary next to it doing the same for flags. A provider added without a rung
 * in either resolved to `null` and simply did not launch.
 *
 * Settings arrive as a parameter rather than through `getAllSettings()` so the
 * decision is testable without a database. `host-tools.ts` keeps the thin
 * IO-bound wrapper.
 */

import { PROVIDER_REGISTRY } from './registry';
import type { AgentProviderId, ProviderSettingKeys } from './registry';

/**
 * The settings this module reads — exactly the provider keys, so it stays free
 * of the db types while still being what `Settings` structurally provides.
 */
export type ProviderSettings = ProviderSettingKeys;

/**
 * The base command for a provider.
 *
 *  1. an explicit override, when the caller passed one;
 *  2. the owner's `agent_command_<id>` setting;
 *  3. the registry's `defaultCommand`.
 *
 * Returns null when nothing resolves — which is the correct answer for `custom`,
 * whose registry default is empty on purpose: a custom agent IS its command, so
 * guessing one would launch the wrong thing.
 */
export function resolveAgentCommand(
    agent: AgentProviderId,
    override: string | undefined,
    settings: ProviderSettings,
): string | null {
    const explicit = override?.trim();
    if (explicit) return explicit;

    const def = PROVIDER_REGISTRY[agent];
    const configured = settings[def.commandSettingKey]?.trim();
    if (configured) return configured;

    return def.defaultCommand.trim() || null;
}

/** The owner's always-on flags for a provider, or '' when none are set. */
export function resolveAgentFlags(
    agent: AgentProviderId,
    settings: ProviderSettings,
): string {
    return settings[PROVIDER_REGISTRY[agent].flagsSettingKey] ?? '';
}
