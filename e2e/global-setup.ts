import { warmElectronRuntime } from './helpers/launch';

/**
 * Pay the run's first Electron boot here, where nothing is timing it (genie#369).
 *
 * Playwright runs this once per invocation, before any spec and outside every
 * test's budget — which is the whole point. `agent-access.spec.ts` sorts first
 * alphabetically, so until now it stood in front of the run's cold start every
 * time, and `launchGenieE2E` waits for `firstWindow()` on Playwright's 30s
 * default. On the Windows logs that cost 13-15s on a healthy runner and 34-35s
 * on a slow one, against a second launch moments later costing ~5s.
 *
 * NOT a bigger timeout, on purpose. The same shape as the genie#425
 * wait-for-exit: take the variable cost out of the timed window rather than
 * widen the window, so 30s goes back to measuring the app.
 *
 * It never throws. A warm-up is an optimisation, and a runner that cannot spare
 * the boot should get a slow suite rather than a red one — the failure it would
 * otherwise cause is worse than the one it is fixing, and it would land before
 * any test had run, with nothing on screen to explain it.
 *
 * The timing line is deliberate: it is the number this change is judged on, and
 * without it the next person has to re-derive the cold-start cost from spec
 * timings the way genie#369 did over eight comments.
 */
export default async function globalSetup(): Promise<void> {
    const result = await warmElectronRuntime();
    if (result.ok) {
        console.log(`[e2e] warmed the Electron runtime in ${result.ms}ms (genie#369)`);
        return;
    }
    console.warn(
        `[e2e] warm-up did not complete after ${result.ms}ms — continuing; ` +
            `the first spec pays the cold start as before. ${result.error ?? ''}`,
    );
}
