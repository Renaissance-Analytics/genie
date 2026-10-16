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
        // Genie's preload, and the doctor window's (it exposes `genieDoctor`, never Genie's bridge).
        lib: { entry: { preload: 'src/main/preload.ts', 'doctor-preload': 'src/main/doctor-preload.ts', 'question-preload': 'src/main/question-preload.ts' }, formats: ['cjs'], fileName: (_format, name) => `${name}.cjs` },
        rollupOptions: { external: ['electron', /^node:/] },
    },
});
