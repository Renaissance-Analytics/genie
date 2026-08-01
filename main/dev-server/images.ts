/**
 * The workspace dev image, and where it comes from.
 *
 * ## The decision (P1)
 *
 * ONE multi-language Genie base image, not per-stack images pulled on demand.
 * The workspace — not the repo — is the sandbox boundary, and a workspace
 * routinely holds a Node frontend, a PHP API and a Python worker at once. Per-
 * stack images would mean either several dev containers per workspace (three
 * bind mounts of the same directory, three sets of node_modules semantics) or
 * choosing a "primary" stack per workspace, which is exactly the PHP-first
 * mistake beta.218 made. One image is bigger to pull once and simpler forever.
 *
 * ## NOT BUILT IN P1 — the P2 hand-off
 *
 * P1 deliberately only REFERENCES this image; nothing here builds, publishes or
 * pulls it. The point of P1 is the runtime + sandbox lifecycle, and that is
 * provable with any base image (the tests use `alpine`, and
 * `ensureWorkspaceSandbox` takes an `image` override for exactly this reason).
 *
 * What P2 has to decide and build:
 *
 *   1. **Contents.** Node LTS + pnpm/npm, PHP + Composer, Python + uv, Go, Rust,
 *      plus git and a non-root `genie` user whose uid/gid can be matched to the
 *      host's so bind-mounted files are not written as root on Linux.
 *   2. **Where it is built.** A `Dockerfile` in this repo, built and pushed by CI
 *      on tag, multi-arch (amd64 + arm64 — Apple Silicon and the cloud fleet are
 *      both real).
 *   3. **Where it is published.** GHCR under the repo's own org, so the desktop
 *      and Genie Cloud pull the identical digest. The tag is PINNED (`:1`, not
 *      `:latest`) because a workspace's toolchain must not change under it on a
 *      restart.
 *   4. **How it arrives.** A `pullImage` on {@link ContainerRuntime} plus a
 *      first-run progress surface. P1 reports {@link SandboxFailureReason}
 *      `image-missing` with the exact `docker pull` to run instead of pulling
 *      silently — a multi-GB download must be something the user agreed to.
 *   5. **Escape hatch.** A workspace that needs something else sets its own
 *      image; the layered site resolution in P2 (Dockerfile / devcontainer /
 *      detected / explicit) is where that surfaces.
 */

/** The default workspace dev image. Pinned — never `:latest`. */
export const GENIE_DEV_BASE_IMAGE = 'ghcr.io/renaissance-analytics/genie-dev-base:1';

/** Where the workspace directory appears inside the dev container. */
export const WORKSPACE_MOUNT_TARGET = '/workspace';

/**
 * What the dev container runs so that it STAYS running.
 *
 * A container exits the moment its main process does, and a sandbox that dies as
 * soon as it is created is not a sandbox — the repos' dev servers are started
 * later, with `exec`, into a container that is already up.
 *
 * `tail -f /dev/null` rather than `sleep infinity`: busybox (and therefore
 * alpine, which the tests and any minimal base image use) only grew
 * `sleep infinity` recently, while `tail -f /dev/null` idles correctly on every
 * base image there is.
 */
export const DEV_CONTAINER_HOLD_COMMAND: readonly string[] = ['tail', '-f', '/dev/null'];
