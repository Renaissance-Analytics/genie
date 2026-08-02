import { DEV_BASE_TOOLCHAIN, GENIE_DEV_BASE_IMAGE } from './images';
import { devServiceManager } from './services/service-manager';
import { resolveContainerRuntime } from './index';
import type { DevBaseToolchain } from './images';
import type { EngineInventoryRow } from './services/inventory';
import type { RuntimeProbe, RuntimeUnavailableReason } from './container-runtime';
import type { EngineActionRequest, EngineActionResult } from './services/service-manager';

/**
 * THE WORKSTATION view of the Dev Server (#234) — one read that answers "what
 * can this MACHINE do, and what is it doing".
 *
 * ## Why there is a machine-level page at all
 *
 * Everything else in the Dev Server is scoped to a workspace, because a site
 * is: one container, one project, gone when the project is. A service ENGINE is
 * not. One `postgres:16` serves every workspace pinned to Postgres 16, its
 * image is pulled once for the machine, and the container runtime underneath is
 * a property of the computer. Those three things have no workspace to belong
 * to, and asking a workspace panel about them gets you a partial answer at best
 * and a dangerous one at worst — "Postgres 16, running" tells you nothing about
 * the five other projects that stop with it.
 *
 * ## Everything here is a READ
 *
 * Opening this must never pull an image, build anything or start a container.
 * `imageExists` is a local lookup, `psServices` is a list, and detection is two
 * process spawns. A settings page that downloads several gigabytes because
 * someone clicked it is the failure this rule exists to prevent — the same rule
 * the workspace Site Manager already follows.
 *
 * ## No runtime is a STATE, not an error
 *
 * Most machines have no Docker the first time this is opened. The catalog is
 * still the honest answer to "what could I run here", so the engines come back
 * with everything `absent` and the runtime block carries the install hint. The
 * page leads with what to do; it does not render an empty error.
 */

// --- what the renderer gets -------------------------------------------------

export interface WorkstationRuntimeInfo {
    /** `docker`, `podman`, or `none`. */
    kind: string;
    version?: string;
    /** Present when `kind` is `none`: the sentence that says what to do. */
    installHint?: string;
    /** Which of the two it is — INSTALLED-but-stopped and NOT-INSTALLED need
     *  opposite advice, and telling someone to install Docker when Docker is
     *  installed sends them round a loop they cannot exit. */
    reason?: RuntimeUnavailableReason;
    /** What each candidate reported. "docker: found, engine unreachable" is the
     *  sentence that ends a support thread. */
    probes: RuntimeProbe[];
}

export interface WorkstationDevBaseInfo {
    image: string;
    /** The image is on this machine. Established without downloading it. */
    installed: boolean;
    /** The language runtimes it provides — see `images.ts`. */
    toolchain: readonly DevBaseToolchain[];
}

export interface WorkstationDevServerInfo {
    runtime: WorkstationRuntimeInfo;
    devBase: WorkstationDevBaseInfo;
    /** Shared service engines: installed, running, and who holds each. */
    engines: EngineInventoryRow[];
    /** Set when the engine inventory could not be built at all. */
    error?: string;
}

// --- the read ---------------------------------------------------------------

export async function workstationDevServerInfo(): Promise<WorkstationDevServerInfo> {
    let runtime: WorkstationRuntimeInfo = { kind: 'none', probes: [] };
    let devBaseInstalled = false;

    try {
        const resolved = await resolveContainerRuntime();
        const { detection } = resolved;
        runtime = {
            kind: detection.kind,
            ...(detection.version ? { version: detection.version } : {}),
            ...(detection.installHint ? { installHint: detection.installHint } : {}),
            ...(detection.reason ? { reason: detection.reason } : {}),
            probes: detection.probes,
        };
        if (resolved.runtime) {
            devBaseInstalled = await resolved.runtime
                .imageExists(GENIE_DEV_BASE_IMAGE)
                .catch(() => false);
        }
    } catch (e) {
        runtime = {
            kind: 'none',
            installHint: e instanceof Error ? e.message : String(e),
            probes: [],
        };
    }

    const devBase: WorkstationDevBaseInfo = {
        image: GENIE_DEV_BASE_IMAGE,
        installed: devBaseInstalled,
        toolchain: DEV_BASE_TOOLCHAIN,
    };

    // The manager owns the reference count, so it owns the inventory. Absent
    // (headless, an early boot, a test) is not an error: the runtime block above
    // is still worth showing.
    const manager = devServiceManager();
    if (!manager) return { runtime, devBase, engines: [] };
    try {
        return { runtime, devBase, engines: await manager.inventory() };
    } catch (e) {
        return {
            runtime,
            devBase,
            engines: [],
            error: e instanceof Error ? e.message : String(e),
        };
    }
}

/**
 * Machine-level start / stop / logs for ONE shared engine.
 *
 * Routed through the manager rather than the runtime, because the manager holds
 * the reference count: a container stopped behind its back would leave every
 * holder pointing at something that no longer exists.
 */
export async function workstationEngineAction(
    req: EngineActionRequest,
): Promise<EngineActionResult> {
    const manager = devServiceManager();
    if (!manager) {
        return {
            ok: false,
            error: 'The Genie Dev Server is not running in this process, so engines cannot be managed here.',
        };
    }
    return manager.engineAction(req);
}
