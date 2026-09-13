/**
 * Next.js config for the Genie renderer. Nextron expects export-mode for
 * production so the static HTML can be loaded over the file:// protocol
 * by Electron.
 */
module.exports = {
    output: 'export',
    // assetPrefix './' makes Next.js emit relative asset URLs
    // (./_next/static/...) instead of absolute (/_next/static/...).
    // Under file:// — which packaged Electron uses for the renderer —
    // absolute paths resolve to the filesystem root and every JS/CSS
    // chunk 404s. Symptom: "Waiting for preload bridge…" forever
    // because the renderer's React bundle never runs and window.genie
    // never lands. Only applied for production builds; dev still
    // serves over http://localhost:8888 where absolute paths are fine.
    assetPrefix: process.env.NODE_ENV === 'production' ? './' : undefined,
    images: { unoptimized: true },
    distDir: process.env.NODE_ENV === 'production' ? '../app' : '.next',
    trailingSlash: false,
    typescript: { ignoreBuildErrors: true },
    // fancy-term ships pure ESM with `import { Terminal } from
    // '@xterm/xterm'` (a CJS package). During build-time page-data
    // collection Next loads externals with Node's real ESM loader, whose
    // cjs-module-lexer can't see xterm's UMD exports — named-import
    // SyntaxError. Transpiling the package routes it through the bundler,
    // which handles the CJS interop fine.
    transpilePackages: ['@particle-academy/fancy-term'],
    // The renderer reaches the main process via window.genie only — no
    // network calls from inside Next directly.
    reactStrictMode: false,
    // Some fancy-ui deps reach for node built-ins; the renderer has no node
    // access, so in the BROWSER they resolve to an empty module. Next 16 builds
    // with Turbopack, which has no webpack `resolve.fallback`: this is its
    // equivalent, scoped by the `browser` condition so server-side page-data
    // collection still gets the real modules.
    turbopack: {
        resolveAlias: {
            fs: { browser: './lib/node-builtin-stub.js' },
            path: { browser: './lib/node-builtin-stub.js' },
            os: { browser: './lib/node-builtin-stub.js' },
        },
    },
};
