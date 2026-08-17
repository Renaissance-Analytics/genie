import { networkNameFor } from './argv';
import { ensureWorkspaceSandbox, teardownWorkspaceSandbox } from './workspace-sandbox';
import type { ContainerRuntime, RuntimeDetection } from './container-runtime';
import type { HostIds } from './host-ids';
import type { DevSiteManager, DevWorkspace } from './site-manager';
import type { DevServiceManager } from './services/service-manager';
import type { DevServices } from './services/services-config';
import type { DevSites } from './sites-config';
import type { TeardownResult } from './workspace-sandbox';

/**
 * The DEV SERVER's APP LIFECYCLE (Tynn #234, P4 item A) — the seam that connects
 * P1–P3's verbs to the moments Genie actually has.
 *
 * P1 built `teardownWorkspaceSandbox` and nothing ever called it. P2 and P3 built
 * `reconcile()` and `stopAll()` and neither was wired to boot or to quit. This
 * file is where those become part of the app, and it lives HERE rather than in
 * `background.ts` for the reason `hosting/restart-sites.ts` gave: the cross-cut
 * between two managers and the sandbox belongs beside them, not inside either,
 * and it has to be testable without an Electron app.
 *
 * ## The three moments, and the one that is deliberately absent
 *
 * **OPEN — warm the sandbox, but only for a workspace that uses this.** The
 * sandbox is idempotent by design (`workspace-sandbox.ts`), so re-ensuring it on
 * every open is free and restarts a dev container that had exited. It is GATED,
 * though, on the workspace having at least one dev site or service configured:
 * a user with Docker installed and twenty workspaces must not silently
 * accumulate twenty idle containers and twenty networks for a feature they have
 * never used. Nothing depends on open-time ensure for correctness — the site
 * manager ensures the sandbox itself before it starts anything — so the gate
 * costs nothing but the warm start it was there to give.
 *
 * **REMOVE — release, stop, then sweep, in that order.** The order is the whole
 * point. `teardownWorkspaceSandbox` removes exactly what carries
 * `genie.workspace`, which is correct and is also why it cannot be the only
 * step: a SHARED service engine deliberately carries no workspace label, so the
 * sweep leaves it running (right) with this workspace still counted as a holder
 * (wrong) — an engine in that state can never stop for anybody. And a site
 * container that is swept while the site manager still has it in `live` keeps
 * being advertised by `genSites()`, so the Testing Browser resolves `<name>.gen`
 * to a port nothing is listening on.
 *
 * **BOOT — adopt what survived, resume what could not.** Whatever is still
 * running has to be re-attached, which is what `adopt()` on each manager does. A
 * service engine and a container sandbox both outlive the app by policy, so for
 * them adoption is usually the whole answer. But adoption cannot cover what did
 * not survive, and two things routinely do not: a HOST-NATIVE site has no
 * container at all (Genie quits to install an update and its dev servers go with
 * it), and a container site's processes are exec'd INTO a sandbox that a Docker
 * or host reboot restarts empty. Either way the site is dark and stays dark until
 * a human restarts it by hand, once per site — the reported "every time I update,
 * all our sites go down". `resumeEnabledSites()` closes that gap.
 *
 * The line it does NOT cross is the one that policy was always about: `enabled`
 * IS the user asking for the site to be served, and only those come back. A site
 * nobody enabled still starts nothing because Genie launched.
 *
 * **QUIT — stop nothing.** Not an omission. A service engine is created with
 * `restart: unless-stopped` precisely so it outlives the app; stopping it on
 * quit would fight the policy that created it. And a dev server is long-running
 * work — Genie quits to APPLY AN UPDATE, and killing a user's running dev
 * servers to install a patch is the same mistake as killing their terminals.
 * What is not stopped on quit is re-adopted on boot; that pairing is the design,
 * and it is why `adopt()` exists at all.
 */

// --- deps -------------------------------------------------------------------

export interface ResolvedRuntimeLike {
    runtime: ContainerRuntime | null;
    detection: RuntimeDetection;
}

export interface DevServerLifecycleDeps {
    /** Which runtime, and is it usable. Called per action, so installing Docker
     *  mid-session works without a restart. */
    resolveRuntime: () => Promise<ResolvedRuntimeLike>;
    /** The workspace being acted on, or null when it is already gone. */
    workspaceFor: (workspaceId: string) => DevWorkspace | null;
    devSitesFor: (workspaceId: string) => DevSites;
    devServicesFor: (workspaceId: string) => DevServices;
    /** Read lazily: the managers are created after this, and a test supplies
     *  either or neither. */
    sites: () => DevSiteManager | null;
    services: () => DevServiceManager | null;
    platform?: NodeJS.Platform | string;
    image?: string;
    mountTarget?: string;
    hostIds?: HostIds | null;
}

/** Why a workspace open did not warm a sandbox. Never an error — every one of
 *  these is an ordinary state, and open must not fail on any of them. */
export type SandboxSkipReason =
    /** No usable Docker/Podman on this machine. The common first-run case. */
    | 'no-runtime'
    /** The workspace has no dev sites and no dev services. */
    | 'not-used-here'
    /** The row is gone (removed between the click and this call). */
    | 'unknown-workspace'
    /** The sandbox itself declined — a missing image, an unmountable path. */
    | 'sandbox-failed';

export interface OpenResult {
    ensured: boolean;
    reason?: SandboxSkipReason;
    /** Present on `sandbox-failed` — the sentence the sandbox produced. */
    message?: string;
}

export interface DevServerLifecycle {
    onWorkspaceOpen(workspaceId: string): Promise<OpenResult>;
    onWorkspaceRemove(workspaceId: string): Promise<TeardownResult>;
    /** Re-attach to everything already running. Boot only. Never throws. */
    onBoot(): Promise<void>;
}

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export function createDevServerLifecycle(deps: DevServerLifecycleDeps): DevServerLifecycle {
    /** Does this workspace use the Dev Server at all? Configured, not running —
     *  a site the user has switched off still means "warm my sandbox". */
    const usesDevServer = (workspaceId: string): boolean => {
        try {
            if (Object.keys(deps.devSitesFor(workspaceId)).length > 0) return true;
            return Object.keys(deps.devServicesFor(workspaceId)).length > 0;
        } catch {
            return false;
        }
    };

    return {
        async onWorkspaceOpen(workspaceId) {
            if (!usesDevServer(workspaceId)) return { ensured: false, reason: 'not-used-here' };
            const workspace = deps.workspaceFor(workspaceId);
            if (!workspace) return { ensured: false, reason: 'unknown-workspace' };

            const { runtime } = await deps.resolveRuntime();
            // The ordinary first-run state, and the reason this returns a result
            // instead of throwing: opening a workspace on a machine with no
            // Docker must be completely silent.
            if (!runtime) return { ensured: false, reason: 'no-runtime' };

            // No `confirmImagePull` seam, deliberately: absent means NO PULL
            // (`workspace-sandbox.ts`). Opening a workspace is the last place a
            // multi-gigabyte download should be able to begin — the site
            // manager asks for consent when a site is actually started.
            const result = await ensureWorkspaceSandbox(workspaceId, workspace.path, {
                runtime,
                ...(deps.platform === undefined ? {} : { platform: deps.platform }),
                ...(deps.image === undefined ? {} : { image: deps.image }),
                ...(deps.mountTarget === undefined ? {} : { mountTarget: deps.mountTarget }),
                ...(deps.hostIds === undefined ? {} : { hostIds: deps.hostIds }),
            });
            return result.ok
                ? { ensured: true }
                : { ensured: false, reason: 'sandbox-failed', message: result.message };
        },

        async onWorkspaceRemove(workspaceId) {
            const errors: string[] = [];

            // 1. RELEASE the services FIRST. A shared engine carries no
            //    workspace label, so the sweep below will not touch it — which
            //    is right, and is exactly why the refcount has to be corrected
            //    here instead. Releasing also detaches the engine from this
            //    workspace's network, without which the network cannot be
            //    removed at all.
            const services = deps.services();
            if (services) {
                for (const row of services.list(workspaceId)) {
                    try {
                        await services.release(workspaceId, row.serviceId);
                    } catch (e) {
                        errors.push(messageOf(e));
                    }
                }
            }

            // 2. STOP the sites. The sweep would remove their containers
            //    anyway, but the manager would keep them in `live` — and
            //    `genSites()` would keep advertising a removed workspace's site
            //    to the Testing Browser, which then resolves a name to a dead
            //    port rather than to nothing.
            const sites = deps.sites();
            if (sites) {
                for (const row of sites.list(workspaceId)) {
                    try {
                        await sites.stop(row.siteId);
                    } catch (e) {
                        errors.push(messageOf(e));
                    }
                }
            }

            // 3. SWEEP whatever still carries the label — the dev container, and
            //    anything P5 adds later with no change here.
            const { runtime } = await deps.resolveRuntime();
            if (!runtime) return { removedContainers: 0, removedNetwork: false, errors };
            const result = await teardownWorkspaceSandbox(workspaceId, { runtime });
            return { ...result, errors: [...errors, ...result.errors] };
        },

        async onBoot() {
            // Services before sites, the same order as the rest of the stack: a
            // site adopted first would be listed before the engine it points at
            // is known, and the one broadcast at the end would show a
            // half-resolved picture.
            try {
                await deps.services()?.adopt();
            } catch {
                /* boot must not fail on a runtime that is misbehaving */
            }
            try {
                await deps.sites()?.adopt();
            } catch {
                /* ditto */
            }
            // …then bring back what could NOT survive (genie#190, genie#216).
            // Adoption is usually the whole answer for a container site, which
            // outlives the app by policy. A HOST-NATIVE site has no container:
            // Genie quits to install an update and its dev servers go with it (on
            // Windows they are not even detached — a detached spawn there pops a
            // stray console, so they are children of Genie's tree). Adoption then
            // finds nothing and every one of them stays dark until a human restarts
            // it by hand, which is precisely the report: "every time I update, all
            // our sites go down and I have to manually restart most of them".
            // `enabled` is the user asking for it to be served, so those resume.
            try {
                await deps.sites()?.resumeEnabledSites();
            } catch {
                /* ditto */
            }
        },
    };
}

/** The workspace network name, re-exported so a caller can name what teardown
 *  removes without reaching into `argv.ts`. */
export { networkNameFor };

// --- the process-wide instance ----------------------------------------------

let instance: DevServerLifecycle | null = null;

/** Create the one lifecycle for this process. Idempotent, like the managers. */
export function initDevLifecycle(deps: DevServerLifecycleDeps): DevServerLifecycle {
    instance ??= createDevServerLifecycle(deps);
    return instance;
}

/** The live lifecycle, or null when the dev server was never initialised (a
 *  test, a headless build that does not want it). Callers use `?.` and carry
 *  on — every one of these hooks is optional by construction. */
export function devLifecycle(): DevServerLifecycle | null {
    return instance;
}

/** Test-only: drop the process-wide instance. */
export function resetDevLifecycleForTests(): void {
    instance = null;
}
