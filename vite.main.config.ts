import { defineConfig } from 'vite';

/**
 * The main process bundle — ESM, because `package.json` is `"type": "module"` and Electron
 * has supported ESM main since 28.
 */
export default defineConfig({
    build: {
        outDir: 'dist/main',
        emptyOutDir: false,
        ssr: true,
        sourcemap: true,
        lib: { entry: 'src/main/main.ts', formats: ['es'], fileName: () => 'main.js' },
        // Electron and Node builtins are provided by the runtime, not bundled.
        rollupOptions: { external: ['electron', /^node:/] },
    },
});
