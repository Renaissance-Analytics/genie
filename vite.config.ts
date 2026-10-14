import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vitest/config';

/**
 * The renderer's build.
 *
 * ## No `@vitejs/plugin-react`
 *
 * Measured: `@vitejs/plugin-react@6` requires `vite@^8`, and vitest pins vite at `<=7`. One of
 * the two had to give, and the plugin's only contribution is Fast Refresh for a dev server —
 * which the house rules forbid on this machine anyway. Vite compiles `.tsx` with esbuild from
 * `jsx: "react-jsx"` in `tsconfig.json` with no plugin at all, so dropping it costs the build
 * nothing and keeps one test runner rather than two.
 *
 * ## `base: './'`
 *
 * Electron loads the built renderer over `file://`, where an absolute `/assets/...` resolves
 * against the filesystem root and every asset 404s into a blank white window.
 */
export default defineConfig({
    base: './',
    plugins: [tailwindcss()],
    build: {
        outDir: 'dist/renderer',
        emptyOutDir: true,
        // A desktop app ships its own sources for its own debugging. Nothing here is served
        // to a third party, so there is nothing to withhold.
        sourcemap: true,
        // Two pages: Genie, and the doctor window (`genie --doctor`), which loads only the doctor renderer.
        rollupOptions: { input: { index: 'index.html', doctor: 'doctor.html', question: 'question.html' } },
    },
    test: {
        /*
         * The tests are the files under `test/`. Vitest's default is every `*.test.*` anywhere, which on 2026-10-12
         * picked up a row's STAGED test under `.patch/` (placed there for the batch's patch script to copy in) and
         * ran it against a tree the row was not applied to yet — a red suite about nothing. The live checks
         * (`test/live/*.live.ts`) are named so they stay out of the default run.
         */
        include: ['test/**/*.test.{ts,tsx}'],
        exclude: ['**/node_modules/**', '.patch/**'],
    },
});
