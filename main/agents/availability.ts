/**
 * The boot-time detect-and-install pass for provider binaries GENIE OWNS
 * (genie#313).
 *
 * ## The bug this closes
 *
 * Selecting the Genie TUI (or Kiwi Code) failed with `command not found`
 * because the `genie` / `kiwi` binaries are never installed and nothing
 * installed them — a gap distinct from, and downstream of, the `genie-tui`
 * naming fix (`registry.ts`'s `defaultCommand`, `db.ts` migration v58).
 *
 * ## The gate: "only when it is actually wanted"
 *
 * The ticket is explicit that boot must NOT install on a host that will never
 * launch the provider: only when there is a workspace (any saved agent there
 * might pick it), or the Genie OS Agent is itself configured to use it.
 * {@link providerWanted} is that gate, and it is the FIRST thing
 * {@link ensureProviderInstalled} checks — a provider Genie does not own
 * (`claude`, `codex`, `custom`) is never wanted, full stop, because Genie has
 * no business installing someone else's CLI or guessing at a `custom` binary.
 *
 * ## Pure decision, injected IO
 *
 * Every real filesystem/process call is injected via {@link AvailabilityDeps},
 * the same split `main/dev-server/seams.ts` and its callers use: the real `where`
 * / `which` probe and the real `npm install -g` live in `availability-effects.ts`
 * and are deliberately untested there, because everything that matters —
 * whether to probe at all, whether to install, whether to trust the result — is
 * decided here and is fully exercised with fakes.
 *
 * ## "A PID is not proof a binary ran" — applied to installs too
 *
 * This repo has a history of Windows `.cmd`-shim detection bugs and of trusting
 * a spawned PID as proof a binary works. The same caution applies to an
 * INSTALL: an installer can exit 0 without leaving anything resolvable on
 * PATH (wrong prefix, a shim written somewhere PATH does not reach). So a
 * successful `runInstall` is never trusted on its own — {@link
 * ensureProviderInstalled} always re-probes with {@link
 * AvailabilityDeps.resolveOnPath} afterward and only reports `installed` when
 * that second probe actually resolves.
 */

import type { AgentProviderId, ProviderDef, ProviderInstallSpec } from './registry';
import { agentProviders, PROVIDER_REGISTRY } from './registry';

/** What the boot pass needs to know to decide whether a provider is wanted. */
export interface AvailabilityContext {
    /** True when the workstation has at least one project workspace — a saved
     *  agent in ANY of them could pick this provider. */
    hasWorkspace: boolean;
    /** The provider the Genie OS Agent is currently configured to launch as
     *  (`resolveWorkstationProvider`'s answer — `agent_default`, or `claude`). */
    osaProvider: AgentProviderId;
}

/**
 * Should Genie even bother making sure `id`'s binary is present?
 *
 * Only for a provider Genie owns, AND only when something could actually
 * launch it. A host with zero workspaces and an OSA on `claude` will never
 * launch `genie` or `kiwi`, so nothing here should try to install them —
 * exactly the case genie#313 calls out by name.
 */
export function providerWanted(id: AgentProviderId, ctx: AvailabilityContext): boolean {
    if (!PROVIDER_REGISTRY[id].ownedBinary) return false;
    return ctx.hasWorkspace || ctx.osaProvider === id;
}

/** The result of attempting to install a provider. */
export interface InstallOutcome {
    ok: boolean;
    /** Short, human-readable detail — stderr/stdout tail, or an exit code. */
    detail: string;
}

/** The IO this module needs, injected so the decision logic never touches a
 *  real filesystem or process. */
export interface AvailabilityDeps {
    /**
     * Resolve a bare command name against PATH, the way `where`/`which` would.
     * MUST return the actual resolved path (or `undefined`) — never a boolean
     * derived from a spawned PID, which proves a process started, not that the
     * binary it named exists (see this module's doc comment).
     */
    resolveOnPath(bin: string): Promise<string | undefined>;
    /** Attempt the install `spec` describes. */
    runInstall(spec: ProviderInstallSpec): Promise<InstallOutcome>;
}

/** What the boot pass learned about one provider. */
export type ProviderAvailability =
    | { id: AgentProviderId; status: 'not-wanted' }
    | { id: AgentProviderId; status: 'available'; command: string }
    | { id: AgentProviderId; status: 'installed'; command: string }
    | { id: AgentProviderId; status: 'unavailable'; reason: string };

/**
 * Detect `id`'s binary, and install it if it is missing, owned, wanted, AND
 * Genie has a working installer for it. Never throws — every branch resolves
 * to a {@link ProviderAvailability}, the same "resolve, never reject" contract
 * `main/dev-server/seams.ts` uses for its own probes.
 */
export async function ensureProviderInstalled(
    id: AgentProviderId,
    ctx: AvailabilityContext,
    deps: AvailabilityDeps,
): Promise<ProviderAvailability> {
    if (!providerWanted(id, ctx)) return { id, status: 'not-wanted' };
    return evaluateProviderInstall(PROVIDER_REGISTRY[id], deps);
}

/**
 * The detect/install decision for a single provider DEFINITION, factored out
 * of {@link ensureProviderInstalled} so the install-attempt branches are
 * testable on their own terms rather than only through whichever registry
 * entries happen to carry an `install` spec today — which, as of genie#313, is
 * none of them (see the comments on `genie` and `kiwi` in `registry.ts`). A
 * caller with a real `AgentProviderId` should go through
 * {@link ensureProviderInstalled}; this is the part worth calling directly
 * from a test.
 */
export async function evaluateProviderInstall(
    def: ProviderDef,
    deps: AvailabilityDeps,
): Promise<ProviderAvailability> {
    const id = def.id;
    const bin = def.defaultCommand;

    const found = await deps.resolveOnPath(bin);
    if (found) return { id, status: 'available', command: found };

    if (!def.install) {
        return {
            id,
            status: 'unavailable',
            reason: `${def.label} is not installed, and Genie does not have an automatic installer for it yet.`,
        };
    }

    const outcome = await deps.runInstall(def.install);
    if (!outcome.ok) {
        return {
            id,
            status: 'unavailable',
            reason: `${def.label} could not be installed automatically: ${outcome.detail}`,
        };
    }

    const installed = await deps.resolveOnPath(bin);
    if (!installed) {
        return {
            id,
            status: 'unavailable',
            reason: `${def.label} reported a successful install, but "${bin}" still does not resolve on PATH.`,
        };
    }
    return { id, status: 'installed', command: installed };
}

/**
 * The full boot-time sweep: one {@link ensureProviderInstalled} per provider,
 * recording every result. Cheap for a provider Genie does not own — it never
 * reaches `resolveOnPath` at all, because `providerWanted` short-circuits
 * first.
 */
export async function ensureOwnedProvidersInstalled(
    ctx: AvailabilityContext,
    deps: AvailabilityDeps,
    ids: readonly AgentProviderId[] = agentProviders(),
): Promise<ProviderAvailability[]> {
    const results: ProviderAvailability[] = [];
    for (const id of ids) {
        const result = await ensureProviderInstalled(id, ctx, deps);
        recordProviderAvailability(result);
        results.push(result);
    }
    return results;
}

// --- the boot result, consulted synchronously at launch time ---------------

const lastKnown = new Map<AgentProviderId, ProviderAvailability>();

/** Record what the boot pass learned, so a later launch attempt can consult it
 *  without any new IO. */
export function recordProviderAvailability(result: ProviderAvailability): void {
    lastKnown.set(result.id, result);
}

/** What the boot pass last recorded for `id`, if anything. */
export function getKnownProviderAvailability(id: AgentProviderId): ProviderAvailability | undefined {
    return lastKnown.get(id);
}

/** Test-only: clear the cache between cases. */
export function resetProviderAvailabilityCache(): void {
    lastKnown.clear();
}

/**
 * Should a FRESH agent launch for `id` be blocked, and if so, with what
 * message? Consults only what the boot pass already learned — never new IO —
 * so this stays synchronous and cheap enough to call from `createAgentTerminal`
 * (`main/terminal/ipc.ts`), which is not async.
 *
 * Fails OPEN: a provider the boot pass never recorded (every provider Genie
 * does not own, or an owned one before its first boot pass has run) is let
 * through unchanged — this is strictly a refinement of "let it try and fail",
 * never a new way to refuse a launch that might have worked. Only a provider
 * the boot pass ACTIVELY marked `unavailable` is blocked.
 */
export function launchBlockReason(id: AgentProviderId): string | undefined {
    const known = lastKnown.get(id);
    return known?.status === 'unavailable' ? known.reason : undefined;
}
