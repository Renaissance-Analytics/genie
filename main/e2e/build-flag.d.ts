/**
 * `__GENIE_E2E_BUILD__` — whether this BUILD contains the E2E rig at all.
 *
 * Substituted as a literal by `scripts/build-main.mjs` (`define`): `false` for a production
 * build, `true` for `build:e2e`. Declared here so both `main/e2e/flags.ts` and
 * `main/background.ts` can read it without each re-declaring the global.
 *
 * ## Why every consumer computes its OWN local const
 *
 * It is tempting to export one `E2E_BUILD` from `flags.ts` and import it everywhere. That
 * does not work, and the failure is silent: rolldown will not propagate a CROSS-MODULE
 * constant into another module's branch condition, so `if (E2E_BUILD && isE2E())` in
 * background.ts is not statically false there — the branch survives, and with
 * `codeSplitting: false` the `await import('./e2e')` inside it gets INLINED, dragging the
 * entire rig back into the bundle.
 *
 * Measured: with the imported-const form, a production build still carried 20 `main/e2e/`
 * files; the bundle shrank by only the 109 KB of code that had moved out of background.ts.
 * A module-LOCAL const computed from the define folds, because the folding happens inside
 * the module that owns it.
 *
 * So the one-line `typeof`-guarded local in each consumer is deliberate, not duplication to
 * be tidied away. `scripts/assert-no-e2e-in-bundle.mjs` is what notices if it is.
 *
 * The `typeof` guard matters too: vitest sets no define, and a bare read of an undeclared
 * global is a ReferenceError rather than `undefined`.
 */
declare const __GENIE_E2E_BUILD__: boolean;
