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
module.exports = {
    webpack: (config /* , env */) => {
        config.optimization = {
            ...(config.optimization ?? {}),
            splitChunks: false,
            runtimeChunk: false,
        };

        // Tier 3 host: Genie no longer builds its own detached pty-host. The host
        // script now ships INSIDE @particle-academy/fancy-term-host
        // (dist/pty-host.js + its chunk). HostSpawner.resolveHostScript() locates
        // it via the package's ptyHostScriptPath(), and electron-builder unpacks
        // the package dist + node-pty so plain Node can require them off disk
        // (see electron-builder.yml asarUnpack). Hence no extra webpack entry here.
        return config;
    },
};
