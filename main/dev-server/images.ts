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
 * ## Where the image comes from
 *
 * `dev-base/` — the Dockerfile, the entrypoint, and the reasoning. Debian trixie
 * with Node, PHP, Python, Go and Rust, and a non-root `genie` user that
 * renumbers itself to `HOST_UID`/`HOST_GID` so bind-mounted files come out owned
 * by the person who owns the workspace. Built and published multi-arch (amd64 +
 * arm64) to GHCR by `.github/workflows/dev-base-image.yml`, and only ever on a
 * `dev-base-v*` tag — a multi-gigabyte image is not something CI republishes on
 * every commit.
 *
 * The constant below is the SINGLE consumer of that name anywhere in the
 * codebase. A same-major republish (`:1` moving) needs no change here at all;
 * only adopting a new major is an edit, and it is this line.
 *
 * ## How it arrives
 *
 * `ContainerRuntime.pullImage`, behind a CONSENT seam. `ensureWorkspaceSandbox`
 * takes `confirmImagePull`, and its absence means NO pull — P1's behaviour
 * verbatim, reporting `image-missing` with the exact `docker pull` to run. That
 * default is deliberate: this is called from workspace-open, and a caller who
 * has not built a progress surface must not be able to start a multi-gigabyte
 * download by forgetting a field.
 *
 * ## The host's identity
 *
 * `HOST_UID`/`HOST_GID` ride `ContainerSpec.env`, detected by `host-ids.ts` (and
 * `null` on Windows and macOS, where the runtime's VM already translates
 * ownership). Rootless Podman needs a different answer — `ContainerSpec.userns:
 * 'keep-id'`, which the argv builder drops for docker — so the two runtimes do
 * NOT share one fix. See `dev-base/README.md`.
 *
 * ## Escape hatch
 *
 * A workspace that needs something else sets its own image; the layered site
 * resolution in `site-def.ts` (Dockerfile / devcontainer / detected / explicit)
 * is where that surfaces.
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
