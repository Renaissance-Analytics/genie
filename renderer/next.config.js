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
    eslint: { ignoreDuringBuilds: true },
    typescript: { ignoreBuildErrors: true },
    // The renderer reaches the main process via window.genie only — no
    // network calls from inside Next directly.
    reactStrictMode: false,
    webpack: (config) => {
        // Some fancy-ui deps reach for node built-ins; mock them as the
        // renderer has no node access.
        config.resolve.fallback = {
            ...config.resolve.fallback,
            fs: false,
            path: false,
            os: false,
        };
        return config;
    },
};
