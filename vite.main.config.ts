import { defineConfig } from 'vite';

/**
 * The main process bundle — ESM, because `package.json` is `"type": "module"` and Electron
 * has supported ESM main since 28.
 */
export default defineConfig({
    // The test build that stops at each step of the keychain move (src/main/migration-holds.ts). Nothing that ships sets it.
    define: { __GENIE_TEST_HOLDS__: process.env.GENIE_TEST_HOLDS === '1' ? 'true' : 'false' },
    build: {
        outDir: 'dist/main',
        emptyOutDir: false,
        ssr: true,
        sourcemap: true,
        // Five entries: `entry` (package.json main) picks doctor mode or Genie; `host` is genie-host, the agent host process
        // the window starts (src/main/genie-host.ts, the host split); `spawn-host` is the child main forks to create
        // processes off its own thread (src/main/spawn-host.ts, genie#1397; the host split's P5 absorbs it). Neither imports
        // anything from electron. Each is its own file, shared code chunks beside them.
        lib: { entry: { entry: 'src/main/entry.ts', main: 'src/main/main.ts', doctor: 'src/main/doctor.ts', host: 'src/main/genie-host.ts', 'spawn-host': 'src/main/spawn-host.ts' }, formats: ['es'], fileName: (_format, name) => `${name}.js` },
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
        rollupOptions: { external: ['electron', 'node-pty', '@napi-rs/keyring', /^node:/] },
    },
});
