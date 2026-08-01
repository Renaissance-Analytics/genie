import { createDockerRuntime } from './docker-adapter';
import { createPodmanRuntime } from './podman-adapter';
import { detectContainerRuntime } from './runtime-detect';
import { defaultCommandRunner } from './seams';
import type { CommandRunner, ContainerRuntime, RuntimeDetection } from './container-runtime';

/**
 * Genie DEV SERVER (Tynn #234) — the public surface of the module.
 *
 * P1 (this) is the container-runtime abstraction and the per-workspace sandbox.
 * P2 adds sites, P3 services, P4 the UX and the retirement of the beta.218
 * native hosting path in `../hosting`. Nothing in `../hosting` is touched by
 * this module: the two run side by side until P4 removes the old one.
 *
 * Callers should reach for {@link resolveContainerRuntime} rather than an
 * adapter, so "which runtime, and is it usable" is answered in one place.
 */

export type {
    BindMount,
    CommandResult,
    CommandRunner,
    ContainerRef,
    ContainerRuntime,
    ContainerRuntimeKind,
    ContainerSpec,
    ContainerState,
    ContainerSummary,
    NetworkRef,
    PortMapping,
    PortPublish,
    RuntimeDetection,
    RuntimeProbe,
    RuntimeUnavailableReason,
    StreamHandle,
} from './container-runtime';

export { PREFERRED_RUNTIMES } from './container-runtime';
export { ROLE_LABEL, WORKSPACE_LABEL, devContainerNameFor, networkNameFor } from './argv';
export { DEV_CONTAINER_HOLD_COMMAND, GENIE_DEV_BASE_IMAGE, WORKSPACE_MOUNT_TARGET } from './images';
export { toMountSource } from './mount-path';
export { detectContainerRuntime, installHintFor, notRunningHintFor } from './runtime-detect';
export { createDockerRuntime } from './docker-adapter';
export { createPodmanRuntime } from './podman-adapter';
export { defaultCommandRunner } from './seams';
export { ensureWorkspaceSandbox, teardownWorkspaceSandbox } from './workspace-sandbox';
export type {
    SandboxDeps,
    SandboxFailed,
    SandboxFailureReason,
    SandboxOk,
    SandboxResult,
    TeardownResult,
} from './workspace-sandbox';

export interface ResolveRuntimeOptions {
    runner?: CommandRunner;
    platform?: NodeJS.Platform | string;
}

export interface ResolvedRuntime {
    /** `null` when nothing usable is installed — read `detection` to say why. */
    runtime: ContainerRuntime | null;
    detection: RuntimeDetection;
}

/**
 * Pick the container runtime this machine can actually use.
 *
 * Deliberately returns a RESULT rather than throwing or returning a runtime that
 * will fail on first use: "no Docker" is the ordinary first-run state, and
 * `detection.installHint` is the sentence the caller shows.
 *
 * Not memoised. A user who installs Docker, or starts Docker Desktop, must not
 * have to restart Genie for it to be noticed — the probe is two cheap process
 * spawns, and callers that need it hot can cache with their own invalidation.
 */
export async function resolveContainerRuntime(
    opts: ResolveRuntimeOptions = {},
): Promise<ResolvedRuntime> {
    const runner = opts.runner ?? defaultCommandRunner;
    const platform = opts.platform ?? process.platform;
    const detection = await detectContainerRuntime({ runner, platform });

    if (detection.kind === 'docker') {
        return { runtime: createDockerRuntime({ runner, platform }), detection };
    }
    if (detection.kind === 'podman') {
        return { runtime: createPodmanRuntime({ runner, platform }), detection };
    }
    return { runtime: null, detection };
}
