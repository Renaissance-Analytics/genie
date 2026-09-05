import { defineConfig } from '@playwright/test';

/**
 * Playwright config for Genie's Electron E2E suite.
 *
 * Scope: only the `e2e/` directory. Unit tests stay on vitest (vitest.config.ts
 * only globs `__tests__/`), so the two suites never collide.
 *
 * These tests boot the REAL compiled Electron app (app/background.js) via
 * Playwright's Electron support and drive the renderer. The app must be built
 * first (`npm run build:e2e`); the `test:e2e` script chains that build. There is
 * no webServer — Electron loads the exported renderer from app/*.html over
 * file://, so nothing needs serving.
 *
 * Serial + single worker — but that is NOT what keeps two Electron instances
 * apart, and the comment that used to stand here said it was. It claimed the
 * app's single-instance lock made overlap impossible; that lock is explicitly
 * SKIPPED under GENIE_E2E (background.ts: `process.env.GENIE_E2E === '1' ||
 * app.requestSingleInstanceLock()`), because a developer's real running Genie
 * would otherwise make every E2E launch quit before opening a window. Two E2E
 * instances against one profile both boot quite happily — the second just takes
 * ~3x as long to show a window, which is how genie#369 read as "a slow runner".
 *
 * Serial only guarantees one spec starts after the last one finishes. What makes
 * launches non-overlapping is e2e/helpers/instance-lock.ts, which every launch
 * waits on.
 */
export default defineConfig({
    testDir: './e2e',
    testMatch: '**/*.spec.ts',
    fullyParallel: false,
    workers: 1,
    retries: 0,
    // Generous per-test timeout: an Electron cold boot + several 1.5s status
    // polls in the reconnect flow add up.
    timeout: 60_000,
    expect: { timeout: 15_000 },
    reporter: [['list']],
});
