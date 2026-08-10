import { defineConfig } from 'vitest/config';
import path from 'node:path';

/**
 * The REAL HOSTING lane — `npm run test:hosting`.
 *
 * Genie's unit suite and the Playwright hosting E2E both MOCK the container/serve
 * layer (`main/e2e/hosting.ts` answers the `dev:*` channels from an in-memory
 * fixture), so neither ever runs a web server, allocates a real port, or serves a
 * byte — which is exactly how a serve mode that renders a plausible-but-broken
 * Caddyfile shipped (two `hostServe` sites colliding on Caddy's `:2019` admin port;
 * caught here, invisible everywhere else).
 *
 * These `*.real.test.ts` files run the REAL bundled Caddy / php-cgi / Docker and
 * curl them, so a broken hosting config fails CI rather than the owner's afternoon.
 * They need `npm run build:runtime` first (for the Caddy binary) and are Linux+Docker
 * on CI — see the `hosting` job in .github/workflows/ci.yml. Kept OUT of the fast
 * unit run (vitest.config.ts excludes `*.real.test.ts`).
 */
export default defineConfig({
    test: {
        environment: 'node',
        include: ['main/**/__tests__/**/*.real.test.ts'],
        // A real Caddy/php-cgi/Docker spin-up is slower than a unit test but should
        // never HANG; a generous ceiling that still surfaces a wedged server.
        testTimeout: 60_000,
        hookTimeout: 60_000,
        pool: 'forks',
        poolOptions: { forks: { singleFork: true } },
    },
    resolve: {
        alias: {
            electron: path.resolve(__dirname, 'test/electron-mock.ts'),
        },
    },
});
