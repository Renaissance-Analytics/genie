import { test, expect, type ElectronApplication, type Page } from '@playwright/test';
import { launchGenieE2E } from './helpers/launch';

/**
 * Host-loss recovery renderer chain (genie#203, Fix C) — proven against the REAL
 * COMPILED APP.
 *
 * WHY THIS EXISTS: the main-side watchdog is unit-tested (host-recovery.test.ts),
 * but the renderer half — preload listeners → RecoveryBanner → panelRecoverKey
 * remount — was typecheck-only, and the emit/listen channel strings live as bare
 * literals in TWO files (genie-adapter, preload) that typecheck can't cross-check.
 * A rename on one side silently drops recovery in production.
 *
 * So this drives main's OWN emit path (`broadcastToWindows` + the shared channel
 * constants, via `__GENIE_E2E_RECOVERY__`) into the real preload and asserts the
 * banner text + the pane remount. A channel drift fails HERE, not in the field.
 */

let app: ElectronApplication;
let page: Page;

test.beforeAll(async () => {
    ({ app, page } = await launchGenieE2E('terminal-recovery'));
});

test.afterAll(async () => {
    await app?.close();
});

const emitStatus = (state: 'recovering' | 'recovered' | 'degraded') =>
    app.evaluate((_e, s) => {
        (globalThis as Record<string, any>).__GENIE_E2E_RECOVERY__.emitStatus(s);
    }, state);

const reattach = (ids: string[]) =>
    app.evaluate((_e, list) => {
        (globalThis as Record<string, any>).__GENIE_E2E_RECOVERY__.reattach(list);
    }, ids);

test('the recovery banner reflects each status from the real emit path', async () => {
    // Nothing before a loss.
    await expect(page.getByTestId('recovery-banner')).toHaveCount(0);

    await emitStatus('recovering');
    await expect(page.getByTestId('recovery-banner')).toHaveText(
        'Terminal host lost — reconnecting terminals…',
    );

    await emitStatus('recovered');
    await expect(page.getByTestId('recovery-banner')).toHaveText(
        'Terminals reconnected (host recovered). Running agents were restarted.',
    );

    await emitStatus('degraded');
    await expect(page.getByTestId('recovery-banner')).toHaveText(
        'Terminals reconnected in-process. Running agents were restarted.',
    );
});

test('a recover for a terminal remounts its pane, and only its pane', async () => {
    const before = Number(await page.getByTestId('mount-count').textContent());

    // A recover naming t1 bumps its key → the pane subtree remounts (how the real
    // panel rejoins the respawned host).
    await reattach(['t1']);
    await expect(page.getByTestId('mount-count')).toHaveText(String(before + 1));

    // A recover that does NOT name t1 must leave it mounted — no churn.
    await reattach(['someone-else']);
    await expect(page.getByTestId('mount-count')).toHaveText(String(before + 1));
});
