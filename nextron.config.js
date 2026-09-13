/**
 * Nextron webpack overrides for the main + preload bundles.
 *
 * Why this file exists:
 *
 *   Nextron's default main-process webpack config (see
 *   node_modules/nextron/bin/webpack.config.js) emits a single
 *   `background.js` to `app/`, but it doesn't override webpack 5's
 *   default `optimization.splitChunks` behaviour. Once the main
 *   import graph grows (we added github/* modules + a static import
 *   of terminal/ipc), webpack starts extracting vendor + commons
 *   into separate chunks. Their filenames contain hashes
 *   (`vendors-…-8f7531.js`) and they're referenced from
 *   `background.js` via `require()`, BUT Nextron has no step that
 *   copies those chunks into `app/`. Result: a fatal "Cannot find
 *   module './vendors-…'" at electron boot, no IPC handlers ever
 *   register, and the renderer surfaces every terminal call as
 *   "No handler registered for 'terminal:resize'".
 *
 *   Forcing `splitChunks: false` + `runtimeChunk: false` keeps the
 *   main bundle in one file. The bundle gets bigger (a couple
 *   megabytes), but that's the right trade-off for an electron-main
 *   target — it loads from disk once at boot and never streams.
 */
const path = require('path');

module.exports = {
    webpack: (config /* , env */) => {
        // nextron 10 names the main entry `main` and builds `main/main.ts` into
        // `app/main.js`. Genie's main process is `main/background.ts`, and
        // `package.json#main`, the E2E harness and the packaged app all load
        // `app/background.js`. So the default entry is REPLACED rather than
        // renamed around: dropping `main` also stops webpack looking for a
        // `main/main.ts` that does not exist.
        const { main: _nextronDefaultEntry, ...entries } = config.entry ?? {};
        // The GApp preload (Tynn #250) is a SECOND preload bundle, emitted beside
        // `preload.js` as `app-preload.js`. It must be its own entry rather than a
        // module inside the main bundle: it is loaded into a third-party app's
        // sandboxed window, and the whole point is that the file that lands there
        // contains only the two-call bridge surface — not Genie's own preload, and
        // not the main process it would otherwise be bundled with.
        config.entry = {
            ...entries,
            background: path.join(__dirname, 'main/background.ts'),
            'app-preload': path.join(__dirname, 'main/apps/app-preload.ts'),
            // The MCP shuttle (genie#346) runs as its OWN process on the shipped
            // standalone Node, and outlives the Electron process `background.js`
            // is — so it is its own file, never a module inside the main bundle.
            // Its import graph is held to Node built-ins by
            // main/mcp-shuttle/__tests__/entry.test.ts, because plain Node has no
            // `electron` and no app node_modules to resolve anything else from.
            'mcp-shuttle': path.join(__dirname, 'main/mcp-shuttle/main.ts'),
        };

        config.optimization = {
            ...(config.optimization ?? {}),
            splitChunks: false,
            runtimeChunk: false,
        };

        // Resolve `.mjs` so extensionless imports of the DEP-FREE plugin cores
        // (`./signing-core`, `./bundle-files`) find the `.mjs` files. Those cores
        // are shared VERBATIM with the plain-Node CI signer (`sign-plugin.mjs`)
        // and vitest, so they MUST be authored as native ESM (`.mjs`): a CJS
        // `module.exports = …` core bundled into the ESM main output makes the
        // Electron loader throw at boot ("ES Modules may not assign
        // module.exports"). Nextron's base config replaces webpack's default
        // `resolve.extensions` (dropping `.mjs`), so re-add it here — appended
        // last, a pure fallback that only fires when no `.js/.ts` match exists.
        config.resolve = config.resolve ?? {};
        config.resolve.extensions = [
            ...(config.resolve.extensions ?? []),
            '.mjs',
        ];

        // Tier 3 host: Genie no longer builds its own detached pty-host. The host
        // script now ships INSIDE @particle-academy/fancy-term-host
        // (dist/pty-host.js + its chunk). HostSpawner.resolveHostScript() locates
        // it via the package's ptyHostScriptPath(), and electron-builder unpacks
        // the package dist + node-pty so plain Node can require them off disk
        // (see electron-builder.yml asarUnpack). Hence no extra webpack entry here.
        return config;
    },
};
