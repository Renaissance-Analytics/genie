import { defineConfig } from 'vitest/config';

/**
 * One setting, and it exists because of a measured failure rather than taste.
 *
 * `@particle-academy/fancy-term`'s ESM build does `import { Terminal } from '@xterm/xterm'`.
 * xterm ships a CommonJS bundle whose exports Node's cjs-module-lexer cannot detect, so under
 * plain Node ESM that line throws `Named export 'Terminal' not found` — measured:
 * `require('@xterm/xterm')` works, `import('@particle-academy/fancy-term')` does not. Vite's
 * interop handles it in the renderer, which is why the app is fine and the SSR render tests
 * were not: `test/shell-render.test.tsx` and `test/workspace-render.test.tsx` both died at
 * import, on CI and in the test VM.
 *
 * Inlining the package makes vitest transform it through Vite, so the test imports what the
 * renderer imports. It is a consumer-side workaround for a packaging defect that is Fancy's
 * (an ESM build naming an export from a CJS peer), reported to them, and this file should
 * shrink to nothing when it is fixed.
 */
export default defineConfig({
    test: {
        environment: 'node',
        server: {
            deps: {
                inline: ['@particle-academy/fancy-term'],
            },
        },
    },
});
