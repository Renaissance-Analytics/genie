import { defineConfig } from 'vitest/config';
import path from 'node:path';

/**
 * Vitest setup for Genie's main process.
 *
 * - Tests live next to the code under `__tests__/` folders inside `main/`.
 * - The runtime is Node (no DOM) — Electron's renderer-side surface isn't
 *   covered here yet; add a Playwright Electron smoke when we want E2E.
 * - `electron` is aliased to a stub so any module-graph import of
 *   `from 'electron'` resolves cleanly without an Electron runtime. Tests
 *   that need a richer mock should import from the stub and override per
 *   test (vi.mock or direct property assignment).
 * - `better-sqlite3` stays real — db tests use `:memory:` and the actual
 *   binary so migrations + SQL are exercised end to end.
 */
export default defineConfig({
    test: {
        environment: 'node',
        include: ['main/**/__tests__/**/*.test.ts'],
        // Run main-process tests serially. The git + filesystem fixtures
        // mutate cwd-adjacent state and the suite is small — parallelism
        // buys little and risks flakes from racing temp directories.
        pool: 'forks',
        poolOptions: { forks: { singleFork: true } },
        testTimeout: 20_000,
        hookTimeout: 20_000,
        // Inline the terminal backend package so vitest TRANSFORMS it instead of
        // loading it as a pre-bundled external. Genie's adapter tests (e.g.
        // retained-ipc) `vi.mock('node-pty')` to spawn fake ptys; that mock only
        // reaches the package's internal `import 'node-pty'` when the package is
        // part of the transformed module graph. Without this the real node-pty
        // tries to spawn a Windows ConPTY and the test fails with "File not
        // found". Behaviour-identical to when the core lived in-repo.
        server: {
            deps: {
                inline: [/@particle-academy\/fancy-term-host/],
            },
        },
    },
    resolve: {
        alias: {
            electron: path.resolve(__dirname, 'test/electron-mock.ts'),
        },
    },
});
