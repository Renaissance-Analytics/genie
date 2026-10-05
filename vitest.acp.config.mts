import { defineConfig } from 'vitest/config';

/**
 * The REAL ACP lane — `npm run test:acp`.
 *
 * One file: a real `claude-agent-acp` child, a real `initialize` handshake, on the real
 * stored subscription, with no API token in the child's environment. Everything else in
 * `main/acp/` is tested against fakes, which is right for the decisions and proves
 * nothing about the claim that matters — that an adapter and a stored login agree with
 * each other. A fake cannot be wrong about that.
 *
 * Kept OUT of the fast unit run because it starts a real child process. The desktop rule
 * forbids browsers, Electron and long-running dev servers on the owner's machine; a
 * short-lived child killed in the same test is the probe-container case and is allowed,
 * but it has no business running on every `npm test`.
 *
 * It SKIPS, loudly, when the adapter is not installed or no subscription login is
 * present — which is CI's normal state, and must stay that way.
 */
export default defineConfig({
    test: {
        environment: 'node',
        include: ['main/acp/__tests__/**/*.real.test.ts'],
        // A real handshake should take a second. The ceiling is for a child that comes
        // up slowly, not for one that has wedged — the client's own deadline handles that.
        testTimeout: 60_000,
        hookTimeout: 60_000,
        pool: 'forks',
        fileParallelism: false,
    },
});
