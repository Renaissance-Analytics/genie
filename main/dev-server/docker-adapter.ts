import { createCliRuntime } from './cli-runtime';
import type { CliRuntimeOptions } from './cli-runtime';
import type { ContainerRuntime } from './container-runtime';

/**
 * The Docker adapter.
 *
 * Genie Cloud's fleet runs Docker, so this is the reference implementation: a
 * workspace sandbox created here and one created on a cloud workstation are the
 * same containers on the same network with the same labels.
 *
 * Docker-specific facts that shape the shared body in `cli-runtime.ts`:
 *
 *   - **Bind-mount sources are host paths.** Docker Desktop bridges the Windows
 *     filesystem into its VM itself, so `C:/work/acme` is correct as written
 *     (unlike podman — see `mount-path.ts`).
 *   - **The CLI outliving the engine is normal.** `docker` stays on PATH when
 *     Docker Desktop is stopped, which is why detection probes the ENGINE and
 *     distinguishes "not running" from "not installed" (`runtime-detect.ts`).
 *
 * There is no state here beyond the injected seams: two calls return two
 * independent objects, and everything they need is derived from the workspace id.
 */
export function createDockerRuntime(opts: CliRuntimeOptions = {}): ContainerRuntime {
    return createCliRuntime('docker', opts);
}
