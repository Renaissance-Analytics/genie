/**
 * Whether this BUILD contains the E2E rig at all.
 *
 * Every predicate here used to be `process.env.GENIE_E2E === '1'` and nothing more, which
 * meant a shipped Genie carried the whole rig — `registerE2EMocks` (GitHub IPC replaced by
 * fixtures), a fake hosting layer, a tunnel harness and 18 seed modules — one environment
 * variable away from running against a real user's data. Measured from its own sourcemap,
 * that is ~93 KB of `app/background.js`.
 *
 * Gating it harder at runtime would repeat the mistake. `__GENIE_E2E_BUILD__` is a
 * COMPILE-TIME literal: `scripts/build-main.mjs` defines it `false` for a production build
 * and `true` for `build:e2e`. So in a shipped build `E2E_BUILD` is the literal `false`,
 * every predicate below folds to `false`, each `if (isE2E())` becomes dead code, and
 * rolldown drops the rig it reached. The rig is not disabled in the installer — it is not
 * in it.
 *
 * Measured, not assumed: a dead `await import()` behind a false literal really is removed
 * under this build's `codeSplitting: false` (which otherwise INLINES dynamic imports). A
 * probe module referenced only from such a branch was absent from both the bundle and the
 * sourcemap's `sources`. `scripts/assert-no-e2e-in-bundle.mjs` holds that to the real
 * artifact on every build, because it is a claim about the bundler, not about this file.
 *
 * This module imports NOTHING. It is the one piece of `main/e2e/` that production code may
 * reference, so anything it pulled in would be shipped with it.
 */

// `__GENIE_E2E_BUILD__` is declared in ./build-flag.d.ts, which also explains why each
// consumer computes its own local const instead of importing this one.
/**
 * True only in a build made for the E2E suite.
 *
 * `typeof` rather than a bare reference: under `define` this folds to `typeof false ===
 * 'boolean' ? false : false` and collapses, while under vitest — which sets no define —
 * the identifier is undeclared, and a bare read of an undeclared global throws a
 * ReferenceError. The guard is load-bearing, not defensive styling.
 */
export const E2E_BUILD: boolean =
    typeof __GENIE_E2E_BUILD__ === 'boolean' ? __GENIE_E2E_BUILD__ : false;

/** True when the E2E suite is driving this process. */
export function isE2E(): boolean {
    return E2E_BUILD && process.env.GENIE_E2E === '1';
}

/** True when the mobile-server E2E harness is requested (GENIE_E2E_MOBILE=1). */
export function isE2EMobile(): boolean {
    return E2E_BUILD && process.env.GENIE_E2E === '1' && process.env.GENIE_E2E_MOBILE === '1';
}

/** True when the spec under way is driving the real `master` page rather than a harness. */
export function isE2EMaster(): boolean {
    return E2E_BUILD && process.env.GENIE_E2E === '1' && process.env.GENIE_E2E_PAGE === 'master';
}

/** True when the tunnel E2E harness is requested (GENIE_E2E_TUNNEL=1). */
export function isE2ETunnel(): boolean {
    return E2E_BUILD && process.env.GENIE_E2E === '1' && process.env.GENIE_E2E_TUNNEL === '1';
}

/** Optional real-tailnet rung: set to this workstation's Tailscale IP. */
export function isE2ETailscaleTunnel(): boolean {
    return E2E_BUILD && isE2ETunnel() && !!process.env.GENIE_E2E_TAILSCALE_IP;
}
