import {
    ROLE_LABEL,
    WORKSPACE_DEV_ROLE,
    WORKSPACE_LABEL,
    devContainerNameFor,
    networkNameFor,
} from './argv';
import { detectHostIds } from './host-ids';
import { DEV_CONTAINER_HOLD_COMMAND, GENIE_DEV_BASE_IMAGE, WORKSPACE_MOUNT_TARGET } from './images';
import { toMountSource } from './mount-path';
import { CADDY_HTTPS_PORT } from './caddyfile';
import type { HostIds } from './host-ids';
import type { ContainerRef, ContainerRuntime } from './container-runtime';

/** The published loopback host port for the sandbox's Caddy, or undefined when
 *  the container doesn't publish {@link CADDY_HTTPS_PORT} (a pre-rework sandbox)
 *  or the runtime can't report mappings. */
async function readCaddyHostPort(
    runtime: ContainerRuntime,
    containerId: string,
): Promise<number | undefined> {
    try {
        const maps = await runtime.portMappings(containerId);
        return maps.find((m) => m.container === CADDY_HTTPS_PORT)?.hostPort;
    } catch {
        return undefined;
    }
}

/**
 * The per-workspace SANDBOX — the whole of what P1 delivers above the runtime.
 *
 * A workspace gets two things: an **isolated container network** and one
 * **long-lived dev container** with the workspace directory bind-mounted at
 * {@link WORKSPACE_MOUNT_TARGET}. That container is where the repos' dev servers
 * will run in P2 — `npm run dev`, `uvicorn`, `cargo run` — so the stack stops
 * being Genie's problem and arbitrary project code stops running on the user's
 * machine as the user.
 *
 * ## Two properties carry the feature
 *
 * **Idempotence.** `ensureWorkspaceSandbox` is called every time a workspace is
 * opened. The second call must ADOPT what the first one made — find the network,
 * find the container, restart it if it had exited — never stack a second dev
 * container onto the same directory. That is why the names are derived
 * (`argv.ts#devContainerNameFor`) rather than stored: the identity of a
 * workspace's sandbox is a function of the workspace id, so it survives a
 * database that has forgotten, an app update, and a machine reboot.
 *
 * **A missing runtime is a RESULT.** Most desktops have no container runtime the
 * first time this runs — that is the owner's guided-install path, not an error.
 * So nothing here throws: every outcome is a {@link SandboxResult}, and the
 * failure cases carry the sentence the user (or the agent) needs to act on. The
 * house rule from `../hosting/manager.ts` — "failures are STATUSES, not
 * exceptions" — applies with more force here, because this is called from
 * workspace open, where a rejection would take the window down with it.
 *
 * P1 publishes NO ports. There are no sites yet; a container that exposes
 * nothing is the correct starting point, and P2 opens exactly what it needs.
 */

// --- results ---------------------------------------------------------------

export type SandboxFailureReason =
    /** No usable Docker/Podman — `installHint` says what to do. */
    | 'runtime-unavailable'
    /** The dev image is not on this machine, and no consent seam offered to get it. */
    | 'image-missing'
    /** It could have been fetched; the user (or agent) said no. */
    | 'image-pull-declined'
    /** We tried to fetch it and the registry / network said no. */
    | 'image-pull-failed'
    /** The workspace directory cannot be bind-mounted (a network share). */
    | 'unsupported-path'
    /** Anything the runtime threw. */
    | 'error';

export interface SandboxOk {
    ok: true;
    workspaceId: string;
    /** The workspace's isolated network. */
    network: string;
    container: ContainerRef;
    /** Where the workspace directory appears inside the container. */
    mountTarget: string;
    /** What this call actually made, as opposed to adopted. */
    created: { network: boolean; container: boolean };
    /** True when this call fetched the image (a first run, with consent). */
    pulledImage?: boolean;
    /** The loopback host port published to the sandbox's Caddy (container
     *  {@link CADDY_HTTPS_PORT}). The one door every `.gen` site is reached
     *  through; undefined only on a runtime that can't report mappings. */
    caddyHostPort?: number;
}

export interface SandboxFailed {
    ok: false;
    workspaceId: string;
    reason: SandboxFailureReason;
    /** Complete enough to show a user or hand an agent — never just a code. */
    message: string;
    installHint?: string;
}

export type SandboxResult = SandboxOk | SandboxFailed;

/** What a caller is being asked to agree to before a multi-gigabyte download. */
export interface ImagePullConsent {
    image: string;
    /** One sentence naming the image, the workspace, and why it is needed. */
    reason: string;
}

export interface SandboxDeps {
    runtime: ContainerRuntime;
    platform?: NodeJS.Platform | string;
    /** Override the dev image. Tests use `alpine`; P2 uses per-workspace choices. */
    image?: string;
    mountTarget?: string;
    /** Resource ceilings, e.g. `4g` / `2`. Unset means the runtime's default. */
    memory?: string;
    cpus?: string;
    /**
     * Consent for FETCHING a missing dev image.
     *
     * ABSENT MEANS NO PULL — the P1 behaviour, verbatim: report `image-missing`
     * with the command to run. That default is the point of the seam. The dev
     * image is multi-gigabyte, this function is called from workspace-open, and
     * a caller that has not yet built a progress surface must not be able to
     * start a silent download by forgetting a field.
     */
    confirmImagePull?: (req: ImagePullConsent) => Promise<boolean> | boolean;
    /** Raw pull progress, chunk by chunk, for whatever is showing it. */
    onImagePullProgress?: (chunk: string) => void;
    /**
     * The host uid/gid handed to the dev image's entrypoint. Omit to detect
     * (`host-ids.ts`); pass `null` to suppress it deliberately.
     */
    hostIds?: HostIds | null;
}

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * Workspaces whose sandbox we have already refresh-recreated this session.
 *
 * A guard against a remove/recreate LOOP: if a sandbox still can't front the
 * model after one refresh (the machine is offline, or the local dev image
 * genuinely lacks the proxy), we adopt it as-is instead of recreating it again
 * on every ensure. Cleared on a fresh app launch (in-memory), which is exactly
 * when a newly-pulled image should get another chance.
 */
const refreshedSandboxes = new Set<string>();

/** Test-only: forget the once-per-session sandbox-refresh guard. */
export function resetSandboxRefreshForTests(): void {
    refreshedSandboxes.clear();
}

/**
 * Whether a sandbox can actually FRONT the hosting model — i.e. its dev image
 * carries the `caddy` proxy that every `.gen` site is served through.
 *
 * A sandbox created on an OLD dev image (a workspace opened on the update before
 * the caddy-carrying image was pulled) publishes the proxy port but has no caddy
 * binary, so `applyCaddyConfig` fails and every site is dead. Checking for the
 * binary is what lets `ensureWorkspaceSandbox` self-heal such a sandbox by
 * recreating it on the refreshed image.
 */
async function sandboxHasCaddy(runtime: ContainerRuntime, containerId: string): Promise<boolean> {
    try {
        const r = await runtime.exec(containerId, ['sh', '-c', 'command -v caddy >/dev/null 2>&1']);
        return r.code === 0;
    } catch {
        return false;
    }
}

// --- ensure ----------------------------------------------------------------

export async function ensureWorkspaceSandbox(
    workspaceId: string,
    workspacePath: string,
    deps: SandboxDeps,
): Promise<SandboxResult> {
    const platform = deps.platform ?? process.platform;
    const image = deps.image ?? GENIE_DEV_BASE_IMAGE;
    const mountTarget = deps.mountTarget ?? WORKSPACE_MOUNT_TARGET;
    const failed = (reason: SandboxFailureReason, message: string, installHint?: string) =>
        ({ ok: false, workspaceId, reason, message, ...(installHint ? { installHint } : {}) }) as const;

    try {
        const detection = await deps.runtime.detect();
        if (detection.kind === 'none') {
            // Nothing is created on this path — a workspace whose sandbox could
            // not be made must leave no half-built footprint behind.
            const message =
                detection.reason === 'not-running'
                    ? `${deps.runtime.kind} is installed but not running, so the workspace sandbox could not be created.`
                    : 'No container runtime is available, so the workspace sandbox could not be created.';
            return failed('runtime-unavailable', message, detection.installHint);
        }

        // Checked BEFORE anything is created, so an unmountable workspace does
        // not leave an orphan network behind.
        if (!toMountSource(workspacePath, { platform, kind: detection.kind })) {
            return failed(
                'unsupported-path',
                `${workspacePath} cannot be bind-mounted into a container — ` +
                    'the workspace must live on a local absolute path (a network share cannot be mounted). ' +
                    'Move or clone the workspace to a local drive.',
            );
        }

        const name = devContainerNameFor(workspaceId);
        const existing = (await deps.runtime.ps(workspaceId)).find((c) => c.name === name);
        const network = await deps.runtime.networkEnsure(workspaceId);

        if (existing) {
            // Adopt. A dev container that had exited (a reboot, a `docker stop`)
            // is restarted rather than replaced — its filesystem layer may hold
            // an installed toolchain the user has been working in.
            if (existing.state !== 'running') await deps.runtime.start(existing.id);
            const adopt = (caddyHostPort?: number): SandboxOk => ({
                ok: true,
                workspaceId,
                network: network.name,
                container: { id: existing.id, name },
                mountTarget,
                created: { network: network.created, container: false },
                ...(caddyHostPort !== undefined ? { caddyHostPort } : {}),
            });

            const caddyHostPort = await readCaddyHostPort(deps.runtime, existing.id);
            // A sandbox is adoptable only if it can FRONT the model: it publishes
            // the Caddy proxy port AND its image carries the caddy binary. A
            // pre-rework sandbox fails the first; a sandbox created on an OLD dev
            // image (a workspace opened on the update before the caddy-carrying
            // image was pulled) fails the second — the exact "sites down after
            // upgrade" case.
            if (caddyHostPort !== undefined && (await sandboxHasCaddy(deps.runtime, existing.id))) {
                return adopt(caddyHostPort);
            }
            if (refreshedSandboxes.has(workspaceId)) {
                // Already recreated once this session and it still can't front the
                // model (offline, or the local dev image genuinely lacks caddy).
                // Don't loop — adopt as-is; a site start surfaces the missing proxy
                // with a clear error instead of a remove/recreate spin.
                return adopt(caddyHostPort);
            }
            // REFRESH the dev image (best-effort — a same-major republish, e.g. a
            // security or toolchain rebuild that moved `:1`, reaches an existing
            // workspace ONLY this way since `imageExists` short-circuits the pull)
            // then recreate the sandbox from it. Guarded to once per session above.
            refreshedSandboxes.add(workspaceId);
            await deps.runtime
                .pullImage(image, {
                    ...(deps.onImagePullProgress ? { onProgress: deps.onImagePullProgress } : {}),
                })
                .catch(() => {});
            await deps.runtime.remove(existing.id).catch(() => {});
        }

        let pulledImage = false;
        if (!(await deps.runtime.imageExists(image))) {
            // The message has to name the way out, because a bare "image
            // missing" is a dead end for a user AND for an agent driving this
            // through the MCP.
            if (!deps.confirmImagePull) {
                return failed(
                    'image-missing',
                    `The workspace dev image ${image} is not on this machine. ` +
                        `Run \`${deps.runtime.kind} pull ${image}\` and open the workspace again.`,
                );
            }
            const agreed = await deps.confirmImagePull({
                image,
                reason:
                    `The workspace ${workspaceId} needs the dev image ${image}, which is not on ` +
                    'this machine yet. It is a multi-gigabyte download, fetched once and shared ' +
                    'by every workspace afterwards.',
            });
            if (!agreed) {
                return failed(
                    'image-pull-declined',
                    `The dev image ${image} was not downloaded, so the workspace sandbox was not created. ` +
                        `Approve the download, or run \`${deps.runtime.kind} pull ${image}\` yourself.`,
                );
            }
            const pull = await deps.runtime.pullImage(image, {
                ...(deps.onImagePullProgress ? { onProgress: deps.onImagePullProgress } : {}),
            });
            if (!pull.ok) {
                // Distinct from `image-missing`: "we tried and it refused" needs
                // different advice from "nobody has fetched it yet".
                return failed(
                    'image-pull-failed',
                    `Downloading the dev image ${image} failed: ${pull.error ?? 'unknown error'}`,
                );
            }
            pulledImage = true;
        }

        // The host identity the dev image's entrypoint renumbers itself to, so
        // files written into the bind mount stay editable by their owner. Null
        // everywhere the concept does not apply — see `host-ids.ts`.
        const hostIds = deps.hostIds === undefined ? detectHostIds(platform) : deps.hostIds;
        const identityEnv: Record<string, string> = hostIds
            ? { HOST_UID: String(hostIds.uid), HOST_GID: String(hostIds.gid) }
            : {};
        // Podman's half of the same problem, and rootless-ONLY: as root
        // `--userns=keep-id` is an error rather than a no-op.
        const keepId = deps.runtime.kind === 'podman' && hostIds !== null && hostIds.uid !== 0;

        const container = await deps.runtime.runContainer({
            workspaceId,
            name,
            image,
            command: [...DEV_CONTAINER_HOLD_COMMAND],
            network: network.name,
            labels: { [WORKSPACE_LABEL]: workspaceId, [ROLE_LABEL]: WORKSPACE_DEV_ROLE },
            mounts: [{ source: workspacePath, target: mountTarget }],
            // The ONE published door: the sandbox's Caddy listens on
            // CADDY_HTTPS_PORT and every `.gen` site is reached through it (routed
            // by SNI). Loopback only — a workspace's sites are not put on the LAN.
            // Ephemeral host port; read back below.
            ports: [{ container: CADDY_HTTPS_PORT, hostIp: '127.0.0.1' }],
            workdir: mountTarget,
            ...(Object.keys(identityEnv).length ? { env: identityEnv } : {}),
            ...(keepId ? { userns: 'keep-id' as const } : {}),
            // Survive a machine restart: the sandbox should be there when the
            // user comes back, not something they have to remember to recreate.
            restart: 'unless-stopped',
            // A dev container runs whatever the repo spawns, and orphaned
            // children with no reaper accumulate as zombies.
            init: true,
            ...(deps.memory ? { memory: deps.memory } : {}),
            ...(deps.cpus ? { cpus: deps.cpus } : {}),
        });

        const caddyHostPort = await readCaddyHostPort(deps.runtime, container.id);
        return {
            ok: true,
            workspaceId,
            network: network.name,
            container,
            mountTarget,
            created: { network: network.created, container: true },
            ...(pulledImage ? { pulledImage: true } : {}),
            ...(caddyHostPort !== undefined ? { caddyHostPort } : {}),
        };
    } catch (e) {
        return failed('error', messageOf(e));
    }
}

// --- teardown --------------------------------------------------------------

export interface TeardownResult {
    removedContainers: number;
    removedNetwork: boolean;
    /** Non-fatal failures. The sweep continues past each one. */
    errors: string[];
}

/**
 * Remove everything labelled with this workspace.
 *
 * Called when a workspace is removed. It sweeps rather than reads stored ids: the
 * `genie.workspace` label is the record of what belongs to a workspace, so
 * anything the runtime holds for it goes — including containers P2 and P3 will
 * add later, with no change here.
 *
 * Errors are COLLECTED, not thrown. Workspace removal has to complete even when
 * one container refuses to go; aborting the sweep would leave a half-torn-down
 * workspace and no way to finish it.
 */
export async function teardownWorkspaceSandbox(
    workspaceId: string,
    deps: { runtime: ContainerRuntime },
): Promise<TeardownResult> {
    const errors: string[] = [];
    let removedContainers = 0;
    let removedNetwork = false;

    try {
        const detection = await deps.runtime.detect();
        // No runtime means nothing was ever created — removing a workspace must
        // not fail on a machine that never had Docker.
        if (detection.kind === 'none') return { removedContainers: 0, removedNetwork: false, errors };
    } catch (e) {
        return { removedContainers: 0, removedNetwork: false, errors: [messageOf(e)] };
    }

    let rows: Awaited<ReturnType<ContainerRuntime['ps']>> = [];
    try {
        rows = await deps.runtime.ps(workspaceId);
    } catch (e) {
        errors.push(messageOf(e));
    }

    for (const row of rows) {
        try {
            await deps.runtime.stop(row.id);
        } catch {
            // Removal is forced anyway; a failed stop is not worth reporting.
        }
        try {
            await deps.runtime.remove(row.id);
            removedContainers += 1;
        } catch (e) {
            errors.push(messageOf(e));
        }
    }

    // A SHARED service engine (P3) joins this workspace's network but belongs
    // to no workspace, so the label sweep above cannot — and must not — remove
    // it. Detach it instead: Docker refuses to remove a network that still has
    // a container on it, so without this the workspace would be left with an
    // undeletable network, while the engine keeps serving everyone else.
    try {
        const network = networkNameFor(workspaceId);
        for (const engine of await deps.runtime.psServices()) {
            try {
                await deps.runtime.networkDisconnect(network, engine.id);
            } catch (e) {
                errors.push(messageOf(e));
            }
        }
    } catch (e) {
        // Listing engines failing must not stop the teardown — the network
        // remove below may well still succeed.
        errors.push(messageOf(e));
    }

    try {
        // Last: a network with containers still attached cannot be removed.
        await deps.runtime.networkRemove(workspaceId);
        removedNetwork = true;
    } catch (e) {
        errors.push(messageOf(e));
    }

    return { removedContainers, removedNetwork, errors };
}
