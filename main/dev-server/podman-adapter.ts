import { createCliRuntime } from './cli-runtime';
import type { CliRuntimeOptions } from './cli-runtime';
import type { ContainerRuntime } from './container-runtime';

/**
 * The Podman adapter.
 *
 * Podman's CLI is deliberately Docker-compatible, so this shares the body in
 * `cli-runtime.ts` rather than reimplementing eleven verbs that would then drift
 * apart. The differences that actually exist are handled where they belong:
 *
 *   - **Windows bind mounts.** `podman machine` is a Linux VM in WSL; the host's
 *     drives appear there under `/mnt/<drive>`, so `C:\work\acme` has to become
 *     `/mnt/c/work/acme` or the mount silently resolves to an empty directory
 *     inside the VM. See `mount-path.ts`.
 *   - **`ps` names.** Podman models a container's names as a LIST, and some
 *     versions render it bracketed (`[genie-ws-acme-dev]`). `parsePs` strips
 *     that, so name matching works identically on both runtimes.
 *   - **"Not running" means the machine is down.** On Windows and macOS the
 *     remedy is `podman machine start`, not "install podman" — which is why
 *     detection reports the reason rather than a bare failure.
 *
 * Rootless by default is a genuine advantage here: a workspace sandbox that
 * cannot become root on the host is a better sandbox. It also means bind-mounted
 * files are owned by the invoking user, which is what a dev container wants.
 */
export function createPodmanRuntime(opts: CliRuntimeOptions = {}): ContainerRuntime {
    return createCliRuntime('podman', opts);
}
