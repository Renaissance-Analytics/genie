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
import { isAgentTui, type AgentTui } from '../agents/identity';
import { AGENT_TUIS, resolveWorkstationTui } from '../agents/tui';

/** The AI TUIs Genie can launch. Mirrors the agent types the rest of Genie knows. */
export const GAPP_PROVIDERS = AGENT_TUIS;

export type GappProvider = AgentTui;

function known(value: unknown): value is GappProvider {
    return isAgentTui(value);
}

/**
 * The provider a GApp's agents launch under.
 *
 * Three levels, and the order is the point:
 *
 *  1. `gapp_ai_provider` — the workstation's explicit answer to THIS question.
 *  2. the WORKSTATION default (`agent_default`, then `claude`) — resolved by
 *     `agents/provider.ts`, shared with every other agent Genie starts.
 *     Inherited rather than asked again: making somebody configure the same thing
 *     twice is how the second copy ends up stale and wrong.
 *
 * So this is the general resolver with ONE GApp-specific level in front of it,
 * not a second ladder — the two cannot drift apart (Tynn #254).
 *
 * Values arrive from a k/v text table, so an unrecognised one falls THROUGH to
 * the next level rather than being handed to a shell.
 */
export function resolveGappProvider(settings: {
    gapp_ai_provider?: string;
    agent_default?: string;
}): GappProvider {
    if (known(settings.gapp_ai_provider)) return settings.gapp_ai_provider;
    return resolveWorkstationTui(settings);
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
 * A GApp agent's persona briefing is PRE-LOADED INSTRUCTIONS (Tynn #254) with the
 * text supplied by the app, so it lives with the general mechanism in
 * `agents/startup.ts` rather than being a second copy of the shell-quoting here.
 * Re-exported so the GApp call sites keep reading in GApp terms.
 */
export { withPersonaBriefing } from '../agents/startup';
