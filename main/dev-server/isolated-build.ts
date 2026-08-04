import {
    ROLE_LABEL,
    SITE_BUILD_ROLE,
    SITE_LABEL,
    WORKSPACE_LABEL,
    siteBuildContainerNameFor,
    siteBuildVolumeNameFor,
} from './argv';
import { detectHostIds } from './host-ids';
import { DEV_CONTAINER_HOLD_COMMAND } from './images';
import type { ContainerRef, ContainerRuntime } from './container-runtime';
import type { HostIds } from './host-ids';

/**
 * THE ISOLATED BUILD ENVIRONMENT — the fix for genie #119, Blocker 4.
 *
 * ## What was wrong
 *
 * A hosted site's production build used to `exec` into the workspace's long-lived
 * dev container, which bind-mounts the developer's working tree at
 * {@link WORKSPACE_MOUNT_TARGET}. So the build ran IN that live checkout and
 * MUTATED it: hosting `tynn.gen` ran `composer install --no-dev` (deleting
 * pest/phpunit from the real `vendor/`), `rm -rf vendor node_modules`, and
 * `npm run build` (rewriting `public/sw.js` + `public/build/` with `.gen` asset
 * URLs) — all in the user's own directory. It is also the root of the git
 * `dubious-ownership` and `EPERM`-on-overwrite failures: a build running as a
 * foreign uid over host-owned files cannot own its own repo or overwrite a
 * committed file.
 *
 * ## What this does instead
 *
 * Production parity is a build from a FRESH CHECKOUT the builder owns, not the
 * dev tree. So this:
 *
 *   1. drops any stale copy and makes a fresh **named volume** — engine-owned
 *      state that outlives the ephemeral build container and is mountable into
 *      the serve container;
 *   2. starts a short-lived build container on the dev image (the toolchain),
 *      with the volume at {@link WORKSPACE_MOUNT_TARGET} and the repo bind-
 *      mounted **read-only** as the COPY SOURCE — the host tree can be read but
 *      never written;
 *   3. copies the repo into the volume, OWNED BY THE BUILD USER, so git sees a
 *      repo it owns (no dubious ownership) and every committed file is writable
 *      (no EPERM overwrite).
 *
 * The caller then runs the build steps by `exec`ing THIS container in the copied
 * workdir, removes it, and mounts the volume into the serve container. The host's
 * `vendor/`, `node_modules/`, `public/`, `.git` are never touched.
 *
 * ## Why the copy takes ownership of the mount target first
 *
 * The volume the copy lands in can arrive DIRTY, two ways:
 *   - a FRESH named volume does not inherit the image dir's `genie` ownership — on
 *     Docker Desktop (macOS/Windows) the driver mounts it ROOT-owned; and
 *   - a REUSED volume carries root-owned files a previous serve container wrote.
 *     The serve container mounts THIS volume, so the pre-build reset can't drop it
 *     while serve is up, and `volume rm` is tolerant (silently no-ops) — so the
 *     build reuses a stale, part-root-owned tree.
 * Either way the non-root build user's `cp` gets `Permission denied` (the genie
 * #119 regression that broke rebuilding sites). The build user can't `chown` what
 * it doesn't own, but the dev image grants `genie` NOPASSWD sudo, so the copy step
 * `sudo chown -R`s the mount target to `genie` FIRST — RECURSIVE, so nested dirs a
 * prior serve left root-owned are fixed too, not just the volume root — then wipes
 * the workdir (a clean checkout every build) and copies as `genie`. This is the
 * build's OWN engine-owned volume — never the bind-mounted working tree.
 *
 * ## Why the copy runs through `exec`, not the container command
 *
 * `docker exec` resolves the image's `USER genie` against the container's aligned
 * `/etc/passwd`, landing on the same uid every build step will run as; PID 1
 * keeps the uid it started with. A copy made by PID 1 could therefore be owned by
 * a different uid than the build — reintroducing the very dubious-ownership /
 * EPERM failures this removes. So the copy is an `exec`, exactly like the steps.
 */

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * Where the host repo is bind-mounted READ-ONLY inside the build container, as
 * the copy SOURCE. Outside the mount target so it never shadows the volume.
 */
export const BUILD_SOURCE_MOUNT = '/genie-build-src';

export interface PrepareIsolatedBuildDeps {
    runtime: ContainerRuntime;
    workspaceId: string;
    /** The site's opaque id, stamped as a label so a leftover is attributable. */
    siteId: string;
    /** The site's name — what the container/volume names are derived from. */
    siteName: string;
    /** The HOST directory to copy — the repo subdir being served. Read only. */
    hostSource: string;
    /** The workspace network the build joins, for internet + service access. */
    network: string;
    /** The dev image — the one with the toolchain, NOT the site's serve image. */
    image: string;
    /** Where the volume mounts (and the copy's parent), e.g. `/workspace`. */
    mountTarget: string;
    /** The container path the copy lands in and the build then runs in — the
     *  same `run.workdir` the serve container uses (`/workspace/repos/<repo>`). */
    workdir: string;
    platform: NodeJS.Platform | string;
    /** Host uid/gid for the dev image's entrypoint. Omit to detect; `null` to
     *  suppress. Mirrors the workspace sandbox so the build user matches it. */
    hostIds?: HostIds | null;
    /** How long the copy may take — a large tree is not instant. */
    copyTimeoutMs: number;
    /** Live progress, so a card can show the copy the way it shows a build step. */
    onProgress?: (chunk: string) => void;
}

export interface IsolatedBuildEnv {
    /** The ephemeral build container. `exec` the steps here, then remove it. */
    container: ContainerRef;
    /** The named volume holding the copy. Mount it into the serve container. */
    volumeName: string;
}

export type PrepareIsolatedBuildResult =
    | { ok: true; env: IsolatedBuildEnv }
    | { ok: false; error: string };

/**
 * Stand up the isolated build environment: a fresh volume, a build container
 * over it, and the repo copied in and owned by the build user. Never throws —
 * every failure is a result the caller turns into a failed site status.
 */
export async function prepareIsolatedBuild(
    deps: PrepareIsolatedBuildDeps,
): Promise<PrepareIsolatedBuildResult> {
    const { runtime, workspaceId, siteId, siteName, hostSource, network, image, mountTarget, workdir } =
        deps;
    const name = siteBuildContainerNameFor(workspaceId, siteName);
    const volumeName = siteBuildVolumeNameFor(workspaceId, siteName);

    // Clear a stale build container FIRST — a fresh volume cannot be removed
    // while any container (even a stopped one) still references it.
    try {
        const stale = (await runtime.ps(workspaceId)).find((c) => c.name === name);
        if (stale) await runtime.remove(stale.id);
    } catch {
        /* best-effort; a real name clash surfaces from runContainer below */
    }

    // A fresh copy every build — a preview must be a build from a clean checkout,
    // not one accreted across restarts. Tolerant: the volume may not exist yet.
    try {
        await runtime.volumeRemove(volumeName);
    } catch (e) {
        return { ok: false, error: `Could not reset the isolated build copy: ${messageOf(e)}` };
    }

    const hostIds = deps.hostIds === undefined ? detectHostIds(deps.platform) : deps.hostIds;
    const identityEnv: Record<string, string> = hostIds
        ? { HOST_UID: String(hostIds.uid), HOST_GID: String(hostIds.gid) }
        : {};
    // Podman's half of the same problem, and rootless-ONLY — as root
    // `--userns=keep-id` is an error rather than a no-op.
    const keepId = runtime.kind === 'podman' && hostIds !== null && hostIds.uid !== 0;

    let container: ContainerRef;
    try {
        container = await runtime.runContainer({
            workspaceId,
            name,
            image,
            command: [...DEV_CONTAINER_HOLD_COMMAND],
            network,
            labels: {
                [WORKSPACE_LABEL]: workspaceId,
                [ROLE_LABEL]: SITE_BUILD_ROLE,
                [SITE_LABEL]: siteId,
            },
            // The host repo, READ-ONLY, as the copy source: readable, never
            // writable — the working tree cannot be mutated by anything here.
            mounts: [{ source: hostSource, target: BUILD_SOURCE_MOUNT, readOnly: true }],
            // The container-owned copy. Writes land here, not on the host. A
            // fresh volume mounted at the (genie-owned) mount target inherits
            // that ownership, so the build user can populate it directly.
            volumes: [{ name: volumeName, target: mountTarget }],
            workdir,
            ...(Object.keys(identityEnv).length ? { env: identityEnv } : {}),
            ...(keepId ? { userns: 'keep-id' as const } : {}),
            // The build container runs whatever a build step spawns.
            init: true,
        });
    } catch (e) {
        await runtime.volumeRemove(volumeName).catch(() => {});
        return { ok: false, error: `Could not create the isolated build container: ${messageOf(e)}` };
    }

    // Populate the copy, through `exec` so it lands on the build uid (see header).
    // The volume can arrive DIRTY: a fresh one mounts ROOT-owned on Docker Desktop,
    // and a REUSED one carries root-owned files the serve container wrote (the pre-
    // build reset can't drop a volume the running serve container still holds, and
    // `volume rm` is tolerant, so it silently no-ops). So, as `genie` (NOPASSWD sudo
    // in the dev image):
    //   1. `chown -R` the WHOLE mount target to genie — RECURSIVE, so nested dirs a
    //      previous serve left root-owned (e.g. `<workdir>/node_modules`) become
    //      writable, not just the volume root;
    //   2. `rm -rf` the workdir — a clean checkout every build, never one accreted
    //      across restarts (now possible since genie owns everything);
    //   3. `cp -a` the source in as genie — every file owned by the copier, which is
    //      what defeats git dubious-ownership + EPERM regardless of the source's
    //      ownership.
    const copyCommand = [
        'sh',
        '-c',
        `set -e; sudo chown -R genie:genie '${mountTarget}'; rm -rf '${workdir}'; mkdir -p '${workdir}'; cp -a ${BUILD_SOURCE_MOUNT}/. '${workdir}'/`,
    ];
    deps.onProgress?.(`$ ${copyCommand.join(' ')}   # Copy the repo into an isolated build volume\n`);
    let copy;
    try {
        copy = await runtime.exec(container.id, copyCommand, {
            workdir: mountTarget,
            timeoutMs: deps.copyTimeoutMs,
        });
    } catch (e) {
        await runtime.remove(container.id).catch(() => {});
        await runtime.volumeRemove(volumeName).catch(() => {});
        return { ok: false, error: `Preparing the isolated build copy failed: ${messageOf(e)}` };
    }
    if (copy.code !== 0) {
        await runtime.remove(container.id).catch(() => {});
        await runtime.volumeRemove(volumeName).catch(() => {});
        const detail = [copy.stdout, copy.stderr].filter(Boolean).join('\n').trim();
        return {
            ok: false,
            error: `Preparing the isolated build copy failed (exit ${copy.code})${
                detail ? `: ${detail}` : ''
            }.`,
        };
    }

    return { ok: true, env: { container, volumeName } };
}
