import { defineConfig } from 'vitest/config';

/**
 * THE ZIP64 CHECK (`npm run verify:zip64`): a tree past 65,535 entries exported and read back. Not part of `npm test`: it took 172-320 s of a 208-350 s Linux suite, and what it proves changes only
 * with the zip writer. CI runs it when that changes (ci.yml `zip64 acceptance`, test/zip64-acceptance-ci.test.ts holds the rules), and the release runs it on Linux.
 *
 * `*.accept.ts`, so the default run (`test/**\/*.test.{ts,tsx}`) never picks it up.
 */
export default defineConfig({
    test: {
        include: ['test/zip64-acceptance/**/*.accept.ts'],
        exclude: ['**/node_modules/**', '.patch/**'],
        fileParallelism: false,
    },
});
