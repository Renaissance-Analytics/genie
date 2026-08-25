/**
 * PURE. WHICH TUI a new agent launches under (Tynn #254).
 *
 * The rule, which predates saved agents and is unchanged by them: **the
 * WORKSTATION decides.** An agent is spending the owner's subscription and the
 * owner's compute, so the person at the machine picks the harness — not a GApp
 * manifest, and not an agent calling `runAgent`.
 *
 * Where saved agents change it is only in WHEN the question is asked. It is
 * asked ONCE, at CREATION, and the answer is written onto the record. Reattaching
 * never re-resolves it: `codex:tynn-slave` is not a placeholder for "whatever
 * this workstation defaults to today", it is a specific agent holding a specific
 * Codex conversation, and re-resolving would hand the caller a different agent
 * that happens to share a name.
 *
 * This is the general resolver. `apps/agent-provider.ts` layers the GApp-only
 * `gapp_ai_provider` override on top of it — one implementation with one extra
 * level, rather than two ladders that drift.
 */

import type { AgentProvider } from './identity';
import { isAgentProvider } from './identity';

/** The AI TUIs Genie can launch. */
export const AGENT_PROVIDERS: readonly AgentProvider[] = ['claude', 'codex', 'custom'];

/**
 * The workstation's default provider.
 *
 *  1. `agent_default` — what the owner chose in Workstation Setup.
 *  2. `claude` — a real answer, never null. An unresolvable provider means an
 *     agent silently does not launch, which is the failure mode this avoids.
 *
 * Settings arrive from a k/v text table, so an unrecognised value falls THROUGH
 * rather than being handed to a shell.
 */
export function resolveWorkstationProvider(settings: { agent_default?: string }): AgentProvider {
    return isAgentProvider(settings.agent_default) ? settings.agent_default : 'claude';
}
