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
        // Three entries: `entry` (package.json main) picks doctor mode or Genie; each is its own file, shared code chunks beside them.
        lib: { entry: { entry: 'src/main/entry.ts', main: 'src/main/main.ts', doctor: 'src/main/doctor.ts' }, formats: ['es'], fileName: (_format, name) => `${name}.js` },
        // Electron and Node builtins are provided by the runtime, not bundled.
        /*
         * `node-pty` is EXTERNAL, and it has to be: it is a native addon that loads its `.node`
         * binary with a `require` relative to its own package directory. Bundled into
         * `dist/main/main.js`, that relative path points at nothing and the first terminal
         * dies with "Failed to load native module". So the main bundle imports it from
         * `node_modules` at runtime, which `electron-builder.yml` packs explicitly (it is a
         * PEER of fancy-term-host, and electron-builder's dependency walk does not follow
         * peers) and keeps outside the asar (`asarUnpack`). fancy-term-host itself is bundled;
         * its `import { spawn } from 'node-pty'` becomes the external import.
         */
        rollupOptions: { external: ['electron', 'node-pty', /^node:/] },
    },
});
