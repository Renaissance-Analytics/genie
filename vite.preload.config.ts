import { defineConfig } from 'vite';

/**
 * The preload bundle — **CommonJS, and that is not a style choice.**
 *
 * A sandboxed preload (`sandbox: true`) runs in a restricted context that supports only
 * CommonJS. An ESM preload loads as nothing: `window.genie` is simply absent, the renderer
 * falls back to its empty snapshot, and the app opens looking like a Dashboard with no agents
 * rather than like a broken bridge. Hence the `.cjs` extension the main process asks for.
 */
export default defineConfig({
    build: {
        outDir: 'dist/main',
        emptyOutDir: false,
        ssr: true,
        sourcemap: true,
        lib: { entry: 'src/main/preload.ts', formats: ['cjs'], fileName: () => 'preload.cjs' },
        rollupOptions: { external: ['electron', /^node:/] },
    },
});
