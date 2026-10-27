import { defineConfig } from 'vitest/config';

/**
 * THE FLOWS ACCEPTANCE SUITE (`npm run verify:flows`) — every trigger and every node kind the canvas offers, end to end
 * through Genie's real scheduler and runner (test/flows-acceptance/). Not part of `npm test`: the owner (2026-10-27) —
 * "you do not need to run this as part of the full suite, only when we make changes to flows to verify every piece works
 * as intended". CI runs it when a flow path changes (ci.yml `flows acceptance`).
 *
 * - `*.accept.ts`, so the default run (`test/**\/*.test.{ts,tsx}`) never picks these up.
 * - One file at a time: the file trigger and the schedule cases are about TIMING (a settle, a de-duplication window, a
 *   timer due in 400 ms), and a parallel suite's load is the thing they must not be measuring.
 * - `TZ=America/New_York`: "local time" must not be UTC here, or a schedule evaluated in UTC by mistake passes on every
 *   machine whose clock happens to be UTC (the test VMs and CI are). A zone with daylight saving, for the same reason.
 */
export default defineConfig({
    test: {
        include: ['test/flows-acceptance/**/*.accept.ts'],
        exclude: ['**/node_modules/**', '.patch/**'],
        fileParallelism: false,
        testTimeout: 60_000,
        hookTimeout: 30_000,
        env: { TZ: 'America/New_York' },
    },
});
