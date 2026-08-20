import { defineConfig, configDefaults } from 'vitest/config';
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
        // Main-process tests, plus PURE renderer-side logic (no DOM): the
        // renderer has no jsdom harness, so only framework-free helpers (e.g.
        // the keyboard-shortcut intent resolver) are testable here.
        include: [
            'main/**/__tests__/**/*.test.ts',
            'renderer/**/__tests__/**/*.test.ts',
            // `@genie/app-sdk` (Tynn #250) — the package a Genie App developer
            // builds against. Framework-free and DOM-free by design, so it runs
            // in this lane beside the main-process tests.
            'packages/**/__tests__/**/*.test.ts',
        ],
        // `*.real.test.ts` are REAL hosting tests — they spawn the bundled Caddy /
        // php-cgi / Docker and bind real ports, and need `npm run build:runtime`
        // first. They run in their OWN lane (`npm run test:hosting`, see
        // vitest.hosting.config.ts + the CI hosting job), NOT this fast unit run.
        exclude: [...configDefaults.exclude, '**/*.real.test.ts'],
        // Every file shares ONE fork (below), so a file that swaps a global
        // timer and doesn't restore it breaks whichever file runs next. This
        // guard fails the file that LEAKED instead of the innocent one that
        // trips over it — see test/timer-globals-guard.ts and genie#76.
        setupFiles: ['test/timer-globals-guard.ts'],
        // Run main-process tests serially. The git + filesystem fixtures
        // mutate cwd-adjacent state and the suite is small — parallelism
        // buys little and risks flakes from racing temp directories.
        pool: 'forks',
        poolOptions: { forks: { singleFork: true } },
        // The workspace suite spawns many git subprocesses (clone, submodule
        // add, commit). On Windows under machine load these routinely exceed a
        // 20s budget even though they pass on Linux CI — 60s reflects the real
        // cost without masking a hang (create-agi's submodule-explode overrides
        // higher still). Fast tests finish in ms regardless.
        testTimeout: 60_000,
        hookTimeout: 60_000,
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
