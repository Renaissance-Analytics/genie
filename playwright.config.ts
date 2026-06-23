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
 * Serial + single worker: the app keeps a single-instance lock (see
 * app.requestSingleInstanceLock in background.ts), so two Electron instances
 * can't run at once anyway.
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
