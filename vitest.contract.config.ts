import { defineConfig } from 'vitest/config';
import path from 'node:path';

/**
 * The TYNN CONTRACT lane — `npm run test:contract`.
 *
 * Genie's unit suite is offline by design and must stay that way: it runs on
 * every developer's machine, on a plane, in a container with no egress. So the
 * one check that can only be answered by the real Tynn — do the routes Genie
 * calls still exist? — lives in its own lane, exactly like the real-hosting
 * tests do (`vitest.hosting.config.ts`).
 *
 * That separation is what genie#411 cost: Tynn retired `POST /api/v1/wishes`,
 * every quick capture 404'd, and neither repository's suite could see it —
 * Tynn's tests know nothing about a desktop client, Genie's knew nothing about
 * which Tynn routes exist. A cross-repo integration is not testable from inside
 * either repo alone; something has to actually ask.
 *
 * Kept OUT of the fast unit run: `vitest.config.ts` excludes `*.live.test.ts`.
 * Run daily and on Tynn-client PRs by .github/workflows/tynn-contract.yml.
 * Point it elsewhere with `TYNN_CONTRACT_BASE` (a staging host, say).
 */
export default defineConfig({
    test: {
        environment: 'node',
        include: ['main/**/__tests__/**/*.live.test.ts'],
        // Every probe already carries its own 20s abort. This ceiling exists so
        // a wedged connection surfaces as a failure rather than a hung job.
        testTimeout: 120_000,
        hookTimeout: 180_000,
        pool: 'forks',
        poolOptions: { forks: { singleFork: true } },
    },
    resolve: {
        alias: {
            electron: path.resolve(__dirname, 'test/electron-mock.ts'),
        },
    },
});
