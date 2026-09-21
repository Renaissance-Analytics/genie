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

import type { AgentTuiId, TuiDef, ProviderInstallSpec } from './registry';
import { agentCliForProvider } from './agent-cli-catalog';
import { agentTuis, TUI_REGISTRY } from './registry';

/** What the boot pass needs to know to decide whether a provider is wanted. */
export interface AvailabilityContext {
    /** True when the workstation has at least one project workspace — a saved
     *  agent in ANY of them could pick this provider. */
    hasWorkspace: boolean;
    /** The provider the Genie OS Agent is currently configured to launch as
     *  (`resolveWorkstationTui`'s answer — `agent_default`, or `claude`). */
    osaProvider: AgentTuiId;
    /**
     * The command the owner has configured for a provider, if any — the same
     * `settings[def.commandSettingKey]` the launch path reads. Omitted ⇒ probe
     * the registry default, which is what every caller did before and is right
     * whenever nothing is overridden.
     */
    commandFor?(def: TuiDef): string | undefined;
    /**
     * May this host run an UNATTENDED install? Default `true` — the desktop boot
     * is the caller genie#313 was written for, and an omitted flag must not
     * silently disable it.
     *
     * `false` for the E2E suite, which launches the app many times per run in a
     * clean VM: each launch would start a real 255-package network install of
     * the Genie TUI that nothing in the suite is testing, and a test that needs
     * GitHub to be up in order to prove a window opens is not a test of the
     * window. The gate lives HERE, beside the other reasons not to install,
     * rather than as a condition at the call site.
     */
    unattendedInstalls?: boolean;
}

/**
 * Should Genie even bother making sure `id`'s binary is present?
 *
 * Only for a provider Genie owns, AND only when something could actually
 * launch it. A host with zero workspaces and an OSA on `claude` will never
 * launch `genie` or `kiwi`, so nothing here should try to install them —
 * exactly the case genie#313 calls out by name.
 */
export function providerWanted(id: AgentTuiId, ctx: AvailabilityContext): boolean {
    if (!TUI_REGISTRY[id].ownedBinary) return false;
    if (ctx.unattendedInstalls === false) return false;
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
    | { id: AgentTuiId; status: 'not-wanted' }
    | { id: AgentTuiId; status: 'available'; command: string }
    | { id: AgentTuiId; status: 'installed'; command: string }
    | { id: AgentTuiId; status: 'unavailable'; reason: string };

/**
 * Detect `id`'s binary, and install it if it is missing, owned, wanted, AND
 * Genie has a working installer for it. Never throws — every branch resolves
 * to a {@link ProviderAvailability}, the same "resolve, never reject" contract
 * `main/dev-server/seams.ts` uses for its own probes.
 */
export async function ensureProviderInstalled(
    id: AgentTuiId,
    ctx: AvailabilityContext,
    deps: AvailabilityDeps,
): Promise<ProviderAvailability> {
    if (!providerWanted(id, ctx)) return { id, status: 'not-wanted' };
    const def = TUI_REGISTRY[id];
    return evaluateProviderInstall(def, deps, ctx.commandFor?.(def) || def.defaultCommand);
}

/**
 * The detect/install decision for a single provider DEFINITION, factored out
 * of {@link ensureProviderInstalled} so the install-attempt branches are
 * testable on their own terms rather than only through whichever registry
 * entries happen to carry an `install` spec today — which, as of genie#313, is
 * none of them (see the comments on `genie` and `kiwi` in `registry.ts`). A
 * caller with a real `AgentTuiId` should go through
 * {@link ensureProviderInstalled}; this is the part worth calling directly
 * from a test.
 */
export async function evaluateProviderInstall(
    def: TuiDef,
    deps: AvailabilityDeps,
    command: string = def.defaultCommand,
): Promise<ProviderAvailability> {
    const id = def.id;
    // The command the owner ACTUALLY launches, not the registry default.
    // `background.ts` starts the OSA as `settings[commandSettingKey] ||
    // defaultCommand`; this probe read the default alone, so an owner who
    // pointed `agent_command_genie` at a full path was marked unavailable — and
    // `launchBlockReason` then refused a launch that would have worked.
    const bin = command;

    const found = await deps.resolveOnPath(bin);
    if (found) return { id, status: 'available', command: found };

    // ONE TABLE. The install spec comes from the CATALOG, which is the one that
    // is maintained and whose installers are measured end to end
    // (`genie-tui-install-gap.test.ts`). This used to read `TuiDef.install` —
    // a second field that NO registry row has ever set, so this branch was taken
    // every time a binary was missing and `runInstall` was dead code in
    // production. Genie could install its own TUI from the Toolchain page and
    // not at boot, because the two paths read two different tables; and since
    // `launchBlockReason` reads this result and `createAgentTerminal` throws on
    // it, the owner was hard-blocked with "Genie does not have an automatic
    // installer for it yet" moments after Genie had installed it.
    const cli = agentCliForProvider(id);
    const spec = cli?.install ?? null;
    if (!spec) {
        return {
            id,
            status: 'unavailable',
            // The catalog's own sentence when it has one: it says WHY in words
            // the user can act on ("Goose ships as a GitHub release binary…"),
            // which a generic line cannot.
            reason: cli?.installGap
                ? `${def.label} is not installed. ${cli.installGap}`
                : `${def.label} is not installed, and Genie does not have an automatic installer for it yet.`,
        };
    }

    const outcome = await deps.runInstall(spec);
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
    ids: readonly AgentTuiId[] = agentTuis(),
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

const lastKnown = new Map<AgentTuiId, ProviderAvailability>();

/** Record what the boot pass learned, so a later launch attempt can consult it
 *  without any new IO. */
export function recordProviderAvailability(result: ProviderAvailability): void {
    lastKnown.set(result.id, result);
}

/** What the boot pass last recorded for `id`, if anything. */
export function getKnownProviderAvailability(id: AgentTuiId): ProviderAvailability | undefined {
    return lastKnown.get(id);
}

/**
 * RE-PROBE one provider after a deliberate install, and record the answer.
 *
 * `lastKnown` was written once by the boot sweep and by nothing else, so
 * installing the Genie TUI from the Toolchain page left `launchBlockReason`
 * refusing every launch — with the boot pass's "Genie has no installer for it"
 * message — until the app restarted, moments after Genie had installed it. A
 * cache that outlives the fact it caches turns a fixed problem into one that
 * looks unfixable.
 *
 * Probe ONLY: no install branch, deliberately. The person has just installed it
 * on purpose; a refresh that could install would be a second unattended
 * `npm i -g` behind their back, which is the thing `providerWanted` exists to
 * prevent. If the binary is still missing the block correctly stays.
 */
export async function refreshProviderAvailability(
    id: AgentTuiId,
    deps: AvailabilityDeps,
    command?: string,
): Promise<ProviderAvailability> {
    const def = TUI_REGISTRY[id];
    const bin = command || def.defaultCommand;
    let found: string | undefined;
    try {
        found = await deps.resolveOnPath(bin);
    } catch {
        found = undefined;
    }
    const result: ProviderAvailability = found
        ? { id, status: 'available', command: found }
        : {
              id,
              status: 'unavailable',
              reason: `${def.label} is not installed — "${bin}" does not resolve on PATH.`,
          };
    recordProviderAvailability(result);
    return result;
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
export function launchBlockReason(id: AgentTuiId): string | undefined {
    const known = lastKnown.get(id);
    return known?.status === 'unavailable' ? known.reason : undefined;
}
