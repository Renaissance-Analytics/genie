/**
 * The REAL process I/O behind `availability.ts`'s injected {@link
 * AvailabilityDeps} seam (genie#313).
 *
 * Deliberately thin and deliberately untested here, the same way
 * `main/dev-server/seams.ts` itself carries no test file: everything worth
 * asserting — whether to probe, whether to install, whether to trust the
 * result — is decided in `availability.ts` and is fully exercised there with
 * fakes. This module exists only to plug the real commands in at the one call
 * site that needs them (`background.ts`'s boot sequence).
 *
 * Both pieces are reused rather than reimplemented, on purpose:
 *
 *  - {@link resolveOnPath} (`dev-server/toolchain-manager.ts`) already resolves
 *    a bare command name the way `where`/`which` would, respecting Windows
 *    PATHEXT — this is exactly the "verify liveness/resolution properly, not a
 *    spawned PID" requirement genie#313 calls out, and re-deriving it here
 *    would be a second copy of a Windows-shim-sensitive routine to keep in
 *    sync with the first.
 *  - `npm` is a `.cmd` shim on Windows, so an install attempt goes through
 *    {@link hostToolCommandRunner} (`dev-server/seams.ts`), the SAME runner
 *    every other host-tool install in this codebase uses for exactly that
 *    reason (see its doc comment for the CVE-2024-27980 background).
 */

import { hostToolCommandRunner } from '../dev-server/seams';
import { resolveOnPath } from '../dev-server/toolchain-manager';
import { INSTALL_RUN_OPTIONS } from '../dev-server/run-budget';
import type { AvailabilityDeps, InstallOutcome } from './availability';
import type { ProviderInstallSpec } from './registry';

async function runInstall(spec: ProviderInstallSpec): Promise<InstallOutcome> {
    const res = await hostToolCommandRunner.run(
        'npm',
        ['install', '--global', spec.package],
        INSTALL_RUN_OPTIONS,
    );
    return {
        ok: res.code === 0,
        detail: (res.stderr || res.stdout || `npm exited ${res.code}`).trim().slice(0, 2000),
    };
}

/** The live {@link AvailabilityDeps} — real PATH resolution, real `npm`. */
export const liveAvailabilityDeps: AvailabilityDeps = {
    resolveOnPath,
    runInstall,
};
