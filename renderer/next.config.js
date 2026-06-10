/**
 * Next.js config for the Genie renderer. Nextron expects export-mode for
 * production so the static HTML can be loaded over the file:// protocol
 * by Electron.
 */
module.exports = {
    output: 'export',
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
