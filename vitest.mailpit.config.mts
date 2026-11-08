import { defineConfig } from 'vitest/config';

/**
 * GENIE MAIL G1 (`npm run verify:mailpit`, Tynn story #487): measure Mailpit v1.30 in a real container before Genie Mail
 * relies on it. Not part of `npm test`: it starts Docker, and `npm test` runs on people's machines too. CI runs it in its
 * own job (ci.yml `mailpit measure`; test/mailpit-measure-ci.test.ts holds the rules).
 *
 * `*.accept.ts`, so the default run (`test/**\/*.test.{ts,tsx}`) never picks it up. One file, one container: in order.
 */
export default defineConfig({
    test: {
        include: ['test/mailpit-measure/**/*.accept.ts'],
        exclude: ['**/node_modules/**', '.patch/**'],
        fileParallelism: false,
        sequence: { concurrent: false },
        testTimeout: 60_000,
        hookTimeout: 180_000,
    },
});
