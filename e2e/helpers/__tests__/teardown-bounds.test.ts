import { describe, expect, it, vi } from 'vitest';
import type { ElectronApplication } from '@playwright/test';
import { killMasterTerminals, withTeardownBound } from '../launch';

/**
 * A teardown step must be BOUNDED, and must name itself when it overruns.
 *
 * genie#490, the ubuntu face. `main` at `7f594b1d` reported:
 *
 *     ✘ 86 master-window.spec.ts:961 › the palette offers no step Genie would refuse
 *         "afterAll" hook timeout of 60000ms exceeded.   (at :116)
 *         Worker teardown timeout of 60000ms exceeded
 *         112 passed
 *
 * Test 961 passed its own assertions. It is named only because it ran last
 * before a teardown that never returned — so the run reads as "the Flows palette
 * regressed", and someone goes and looks at the palette.
 *
 * ## `.catch(() => {})` is not a guard
 *
 * The hook was written defensively:
 *
 *     if (app) await killMasterTerminals(app).catch(() => {});
 *
 * and that catch CANNOT FIRE. It handles rejection; the failure here is a
 * promise that never settles at all, and `await` on one waits forever no matter
 * what is chained to it. A rejection handler on an unsettled promise is not a
 * timeout, and reading one as a safety net is how an unbounded call passes
 * review — which is the general lesson, not a fact about ptys.
 *
 * `app.evaluate` has no timeout of its own. `identify()` in the same file
 * already races its own against 10s, with a comment saying it must "degrade
 * rather than hang the hook" — so the fix here is the idiom that file already
 * chose, applied to the two steps that had been left out of it.
 *
 * ## Why the bound must SAY something
 *
 * A silent bound trades a 60s hang for a 10s one and still tells nobody which
 * step was stuck. #490 asks for this to be measured rather than reasoned about;
 * naming the step in the log is that measurement, made permanent and free.
 */

/** An app whose `evaluate` NEVER settles — the wedged case, exactly. */
function wedgedApp(): ElectronApplication {
    return { evaluate: () => new Promise<never>(() => {}) } as unknown as ElectronApplication;
}

/** Resolves to 'HUNG' if `work` has not finished in `ms`. */
function hangDetector<T>(work: Promise<T>, ms: number): Promise<T | 'HUNG'> {
    return Promise.race([
        work,
        new Promise<'HUNG'>((r) => setTimeout(() => r('HUNG'), ms)),
    ]);
}

describe('withTeardownBound', () => {
    it('returns the work when it finishes inside the bound', async () => {
        // POSITIVE CONTROL. Every assertion below is "it gave up in time", which
        // a helper that gave up instantly and always would also satisfy.
        await expect(withTeardownBound(Promise.resolve('done'), 5_000, 'step')).resolves.toBe(
            'done',
        );
    });

    it('gives up on work that never settles, and names the step', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            const outcome = await hangDetector(
                withTeardownBound(new Promise<string>(() => {}), 20, 'killMasterTerminals'),
                2_000,
            );

            expect(outcome).not.toBe('HUNG');
            expect(outcome).toBeNull();
            // The whole point: the next CI log says which STEP overran, instead
            // of attributing 60 seconds to whichever test happened to run last.
            expect(warn.mock.calls.flat().join(' ')).toContain('killMasterTerminals');
        } finally {
            warn.mockRestore();
        }
    });

    it('lets a REJECTION through rather than swallowing it as a timeout', async () => {
        // A step that fails fast and one that hangs need different answers, and
        // collapsing them would hide a real teardown error behind "timed out".
        await expect(
            withTeardownBound(Promise.reject(new Error('boom')), 5_000, 'step'),
        ).rejects.toThrow('boom');
    });
});

describe('killMasterTerminals', () => {
    it('returns even when the app never answers the evaluate', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            const outcome = await hangDetector(killMasterTerminals(wedgedApp(), 20), 2_000);

            expect(outcome).not.toBe('HUNG');
        } finally {
            warn.mockRestore();
        }
    });

    it('still actually kills the terminals when the app is healthy', async () => {
        // POSITIVE CONTROL for the bound: a `killMasterTerminals` that returned
        // immediately without ever calling `evaluate` would pass the test above
        // and leave every pty alive — which is the condition that raises the
        // keep-or-shut-down modal this call exists to avoid.
        const evaluate = vi.fn().mockResolvedValue(undefined);
        const app = { evaluate } as unknown as ElectronApplication;

        await killMasterTerminals(app);

        expect(evaluate).toHaveBeenCalledTimes(1);
    });
});
