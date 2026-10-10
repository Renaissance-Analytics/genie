import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

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
    },
});
