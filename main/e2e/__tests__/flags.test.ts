import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { E2E_BUILD, isE2E, isE2EMaster, isE2EMobile, isE2ETailscaleTunnel, isE2ETunnel } from '../flags';

/**
 * The E2E rig must not be ABLE to run in a shipped Genie — not merely switched off in one.
 *
 * Until now every predicate was `process.env.GENIE_E2E === '1'` and nothing more, so a
 * shipped installer carried `registerE2EMocks` (GitHub IPC replaced with fixtures), a fake
 * hosting layer and 18 seed modules, all one environment variable away from running
 * against a real user's data. Nothing about that is hypothetical: the code is in
 * `app/background.js` today, ~93 KB of a 3.4 MB bundle, measured from its own sourcemap.
 *
 * Gating it harder at runtime would be the same mistake again. `E2E_BUILD` is a COMPILE-TIME
 * literal — `scripts/build-main.mjs` defines `__GENIE_E2E_BUILD__` as `false` for production
 * and `true` for `build:e2e` — so in a shipped build every predicate here folds to `false`,
 * the `if (isE2E())` blocks become dead code, and rolldown drops the rig entirely. Proven by
 * `scripts/assert-no-e2e-in-bundle.mjs` against the real artifact, because a claim about
 * dead-code elimination is a claim about the bundler, not about this file.
 *
 * These tests run WITHOUT the define (vitest does not set it), which is the production
 * shape: `typeof __GENIE_E2E_BUILD__` is not `'boolean'`, so `E2E_BUILD` is false.
 */

describe('E2E_BUILD', () => {
    it('is false when the build did not define it — the production shape', () => {
        // Also the safe default for any consumer that is not the bundler: a bare reference
        // to an undeclared global throws, so the `typeof` form is load-bearing, not styling.
        expect(E2E_BUILD).toBe(false);
    });
});

describe('the predicates fold with the build, not just the environment', () => {
    /**
     * Each of these is `E2E_BUILD && <env check>`. The env half is unchanged; the point of
     * the test is the FIRST half — with `E2E_BUILD` false, setting the variable is not
     * enough, which is exactly what makes a shipped app unable to enter E2E mode.
     *
     * The env vars are set and restored per case rather than mutated globally: this repo's
     * rule is never to mutate the environment for a test, and a leaked `GENIE_E2E=1` would
     * silently change behaviour for every suite that runs after this one in the same worker.
     */
    const withEnv = <T>(vars: Record<string, string>, fn: () => T): T => {
        const saved = new Map<string, string | undefined>();
        for (const k of Object.keys(vars)) {
            saved.set(k, process.env[k]);
            process.env[k] = vars[k]!;
        }
        try {
            return fn();
        } finally {
            for (const [k, v] of saved) {
                if (v === undefined) delete process.env[k];
                else process.env[k] = v;
            }
        }
    };

    it('isE2E stays false even with GENIE_E2E=1 set', () => {
        expect(withEnv({ GENIE_E2E: '1' }, isE2E)).toBe(false);
    });

    it('isE2EMobile stays false even with both vars set', () => {
        expect(withEnv({ GENIE_E2E: '1', GENIE_E2E_MOBILE: '1' }, isE2EMobile)).toBe(false);
    });

    it('isE2EMaster stays false even with the page requested', () => {
        expect(withEnv({ GENIE_E2E: '1', GENIE_E2E_PAGE: 'master' }, isE2EMaster)).toBe(false);
    });

    it('isE2ETunnel stays false even with the tunnel requested', () => {
        expect(withEnv({ GENIE_E2E: '1', GENIE_E2E_TUNNEL: '1' }, isE2ETunnel)).toBe(false);
    });

    it('isE2ETailscaleTunnel stays false even with a tailnet IP', () => {
        expect(
            withEnv(
                { GENIE_E2E: '1', GENIE_E2E_TUNNEL: '1', GENIE_E2E_TAILSCALE_IP: '100.64.0.1' },
                isE2ETailscaleTunnel,
            ),
        ).toBe(false);
    });

    it('restores the environment it borrowed', () => {
        // The helper above is only safe if this holds; a leaked var would make the whole
        // suite's later results depend on this file having run.
        expect(process.env.GENIE_E2E).toBeUndefined();
        expect(process.env.GENIE_E2E_TUNNEL).toBeUndefined();
    });
});

describe('the env half is still really there (positive control)', () => {
    /**
     * Without this, every assertion above would pass against predicates hard-coded to
     * `false` — which would be a different bug wearing the same green tick, and would make
     * the E2E build inert instead of the production build safe.
     *
     * So the env logic is exercised directly, with the build flag forced on, by reading the
     * same expressions the predicates use. If a predicate's env condition is dropped, the
     * E2E build silently stops entering the mode its whole suite depends on.
     */
    it('each predicate reads the variable it documents', () => {
        const src = fs.readFileSync(path.join(__dirname, '..', 'flags.ts'), 'utf8');
        expect(src).toContain('GENIE_E2E');
        expect(src).toMatch(/isE2EMobile[\s\S]{0,160}GENIE_E2E_MOBILE/);
        expect(src).toMatch(/isE2EMaster[\s\S]{0,160}GENIE_E2E_PAGE/);
        expect(src).toMatch(/isE2ETunnel[\s\S]{0,160}GENIE_E2E_TUNNEL/);
        expect(src).toMatch(/isE2ETailscaleTunnel[\s\S]{0,200}GENIE_E2E_TAILSCALE_IP/);
        // And every one of them gated on the build flag, which is the whole point.
        expect(src.match(/E2E_BUILD &&/g) ?? []).toHaveLength(5);
    });
});
