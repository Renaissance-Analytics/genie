import { test, expect } from '@playwright/test';
import path from 'node:path';

import { closeGenieE2E, launchGenieE2E } from './helpers/launch';
import { processImageName } from './helpers/instance-lock';

/**
 * A launch does not begin until the previous app has actually exited (genie#369).
 *
 * WHY THIS TEST IS SHAPED THE WAY IT IS. The obvious version — launch an app,
 * assert it opened a window — passes on an idle machine whether the wait works or
 * not, and every developer's machine is idle. So this one MANUFACTURES the
 * condition: it holds an app open on a timer and launches the next one straight
 * away, which is precisely what Playwright does to itself when it stops a worker
 * after a failed test and the replacement worker re-runs the spec's `beforeAll`.
 *
 * And it asserts the mechanism, not a symptom. Overlap does NOT stop the second
 * app from opening a window — measured on Windows, two `master` instances on one
 * profile both boot, the second in 10.3s against a clean 3.2s. Asserting "the
 * second launch succeeded" would therefore pass with the fix reverted. What
 * cannot be true without the wait is the assertion below: that by the time the
 * second Electron process existed, the first was already GONE.
 */

// Two full Electron boots plus a deliberate hold. The suite-wide 60s budget is
// sized for one launch, and a first cold launch on a CI runner can spend 15s of
// it by itself.
test.setTimeout(180_000);

/**
 * How long the first app is held open before it is allowed to close.
 *
 * Sized to be comfortably LONGER than a launch, and that is the whole design of
 * this test. An earlier draft held for 4s and passed with the fix reverted: a
 * launch takes several seconds by itself, so the held app died *during* the
 * second launch and "the first app is gone" came out true without anything ever
 * having waited. The hold has to outlast a launch, or the test proves nothing.
 * Warm launches in CI run 1–5s (the cold first-of-run outlier is another spec's
 * problem — this one is never first), so 20s leaves the margin unambiguous.
 */
const HOLD_MS = 20_000;

test('a launch waits for the previous app to exit, and does not merely start beside it', async () => {
    const first = await launchGenieE2E('issuewatch');
    // The ELECTRON MAIN process, asked of the app itself. Deliberately not
    // `app.process()`: on Windows that is a `cmd.exe` wrapper Playwright spawns
    // Electron through, and watching the most recycled pid on the machine would
    // tell us nothing about Genie.
    const firstId = await first.app.evaluate(() => ({
        pid: process.pid,
        exec: process.execPath,
    }));
    const firstPid = firstId.pid;
    const firstImage = path.basename(firstId.exec);
    expect(firstImage).toMatch(/electron/i);
    // POSITIVE CONTROL for the null-check that carries this test: the same probe,
    // on the same pid, while the app is definitely up. Without it, "the first app
    // is gone" would also pass against a probe that can only ever answer null.
    expect(processImageName(firstPid)).toBe(firstImage);

    // Hold the first app open, then close it on a timer WITHOUT awaiting — the
    // shape of a teardown that has returned while its process is still leaving.
    const closed = new Promise<void>((resolve) => {
        setTimeout(() => {
            void first.app.close().catch(() => {}).then(() => resolve());
        }, HOLD_MS);
    });

    const startedSecond = Date.now();
    const second = await launchGenieE2E('issuewatch');
    const waited = Date.now() - startedSecond;

    try {
        // THE ASSERTION. The first app's process must be gone before the second
        // one exists. Revert the wait in helpers/launch.ts and this is the line
        // that goes red — the second app launches immediately, while the first is
        // still running and still holding the profile.
        expect(
            processImageName(firstPid),
            'the previous Electron instance was STILL RUNNING when the next launch completed',
        ).not.toBe(firstImage);

        // ...and it got there by waiting, not by the first app happening to be
        // quick. Anything below the hold means the launch went ahead early.
        expect(waited).toBeGreaterThan(HOLD_MS * 0.75);

        // The waiting launch is a WORKING launch, not merely a delayed one.
        await expect(second.page.locator('body')).toBeVisible();
    } finally {
        await closed;
        await closeGenieE2E(second.app);
    }
});
