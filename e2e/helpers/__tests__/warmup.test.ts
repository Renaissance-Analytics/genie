import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { E2E_USERDATA, warmElectronRuntime, type WarmupEffects } from '../launch';

/**
 * THE FIRST ELECTRON BOOT OF A RUN IS NOT A TEST'S TO PAY (genie#369).
 *
 * `agent-access.spec.ts` sorts first alphabetically, so it stands in front of
 * the run's cold start every time — and `launch.ts` calls `app.firstWindow()` on
 * Playwright's 30s default. Measured across every Windows launch-timeout log on
 * that issue:
 *
 *     run          first launch → test #1     outcome
 *     c0ba56f      34.2s                      TIMEOUT at #1
 *     5a559e8e     35.5s                      TIMEOUT at #1
 *     30b7e971     15.1s                      ok
 *     5e66e2e7     13.0s                      ok
 *
 * The SECOND launch of the same run costs ~5s. So 8-30s of that first number is
 * a one-time cost that the first spec happens to be standing in front of, and
 * contention cannot explain it — in both timeout runs nothing had launched
 * before it, so there was nothing to contend with.
 *
 * The fix is the one that issue arrived at after retracting two other
 * mechanisms, and it is deliberately NOT a bigger timeout: pay the cold boot
 * once in `globalSetup`, outside any test's budget, so the 30s measures the app
 * rather than a one-time cost. Same shape as the genie#425 wait-for-exit —
 * remove the variable cost from the timed window rather than widen the window.
 *
 * ## What these tests are for
 *
 * They cannot prove the warm-up makes the next launch faster; only CI can, and
 * the PR says so. What they pin is everything that would make the warm-up
 * HARMFUL, which is the part a green suite would otherwise hide:
 *
 *  - it must not touch the suite's own profile;
 *  - it must not fail the run when it fails;
 *  - it must not leak a process for the first spec to wait behind;
 *  - it must actually open a window, not merely spawn one.
 */

function effects(over: Partial<WarmupEffects> = {}) {
    const close = vi.fn().mockResolvedValue(undefined);
    const firstWindow = vi.fn().mockResolvedValue({});
    const launch = vi.fn().mockResolvedValue({ firstWindow, close });
    return { close, firstWindow, launch, e: { launch, ...over } as WarmupEffects };
}

/** The `--user-data-dir=` this launch was given. */
function profileOf(launch: ReturnType<typeof vi.fn>): string {
    const args = (launch.mock.calls[0]?.[0]?.args ?? []) as string[];
    const flag = args.find((a) => a.startsWith('--user-data-dir='));
    return flag?.slice('--user-data-dir='.length) ?? '';
}

describe('warmElectronRuntime', () => {
    it('opens a window, not merely a process', async () => {
        // POSITIVE CONTROL, and the load-bearing one. A warm-up that spawned
        // Electron and returned would pass every other test here while paying
        // almost none of the cost it exists to pay: the expensive part is
        // loading the main bundle and getting a renderer up, which is what
        // `firstWindow` waits for and what the first spec is timing.
        const { launch, firstWindow, e } = effects();

        const result = await warmElectronRuntime(e);

        expect(launch).toHaveBeenCalledTimes(1);
        expect(firstWindow).toHaveBeenCalledTimes(1);
        expect(result.ok).toBe(true);
    });

    it("uses a PRIVATE profile, never the suite's own", async () => {
        // The one way this could quietly corrupt the suite. Every spec shares
        // `E2E_USERDATA`, and a real boot writes to its profile — first-run
        // markers, release-note acknowledgements, window state. A warm-up that
        // booted into that profile would silently change what the specs then
        // find, and the damage would look like a flaky test rather than like
        // this file.
        const { launch, e } = effects();

        await warmElectronRuntime(e);

        const profile = profileOf(launch);
        expect(profile).toBeTruthy();
        expect(path.resolve(profile)).not.toBe(path.resolve(E2E_USERDATA));
    });

    it('does not fail the run when the warm-up fails', async () => {
        // It is an optimisation. A CI runner that cannot spare the boot should
        // get a slow suite, not a red one — turning a performance fix into a new
        // way for the whole shard to die would be a worse trade than the bug.
        const launch = vi.fn().mockRejectedValue(new Error('no display'));

        const result = await warmElectronRuntime({ launch } as unknown as WarmupEffects);

        expect(result.ok).toBe(false);
        expect(result.error).toContain('no display');
    });

    it('closes the app even when the window never arrives', async () => {
        // The genie#425 lesson, applied to the new launch. A warm-up that threw
        // at `firstWindow` and left the process running would hand the FIRST
        // SPEC a live app to wait behind — manufacturing exactly the launch
        // failure this change exists to remove, and doing it before any test
        // has run.
        const close = vi.fn().mockResolvedValue(undefined);
        const launch = vi.fn().mockResolvedValue({
            firstWindow: vi.fn().mockRejectedValue(new Error('Timeout 30000ms')),
            close,
        });

        const result = await warmElectronRuntime({ launch } as unknown as WarmupEffects);

        expect(result.ok).toBe(false);
        expect(close).toHaveBeenCalledTimes(1);
    });

    it('returns even when close() never settles', async () => {
        // BOUNDED, not merely caught — the genie#490 lesson applied to the new
        // launch. `.catch()` handles a rejection; a `close()` that never settles
        // is not a rejection, and `await` on one waits forever whatever is
        // chained to it. Here that would hang `globalSetup`, stalling the whole
        // run before a single test had started, with nothing to say why.
        const launch = vi.fn().mockResolvedValue({
            firstWindow: vi.fn().mockResolvedValue({}),
            close: () => new Promise<void>(() => {}),
        });

        const outcome = await Promise.race([
            warmElectronRuntime({ launch, closeTimeoutMs: 20 } as unknown as WarmupEffects),
            new Promise<'HUNG'>((r) => setTimeout(() => r('HUNG'), 3_000)),
        ]);

        expect(outcome).not.toBe('HUNG');
    });

    it('reports how long the boot took', async () => {
        // The number this change is judged on. Without it the next person has to
        // re-derive the cold-start cost from spec timings the way genie#369 did.
        const { e } = effects();
        const result = await warmElectronRuntime(e);
        expect(typeof result.ms).toBe('number');
    });
});

describe('the suite is wired to warm up', () => {
    it('playwright.config.ts declares a globalSetup that exists', () => {
        // Without this the helper above is dead code that every test passes.
        const root = path.resolve(__dirname, '..', '..', '..');
        const config = fs.readFileSync(path.join(root, 'playwright.config.ts'), 'utf8');
        const declared = config
            .split(/\r?\n/)
            .filter((line) => !line.trim().startsWith('*') && !line.trim().startsWith('//'))
            .map((line) => /globalSetup:\s*'([^']+)'/.exec(line)?.[1])
            .find(Boolean);

        expect(declared, 'playwright.config.ts must declare a globalSetup').toBeTruthy();
        expect(fs.existsSync(path.join(root, declared!))).toBe(true);
    });
});
