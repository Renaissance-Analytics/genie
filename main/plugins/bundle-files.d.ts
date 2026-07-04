/**
 * Type declarations for the dep-free CommonJS bundle-file walk (`bundle-files.js`).
 * The runtime lives in `bundle-files.js` (Node `fs`/`path` only) so the app's
 * installer and the CI signer collect the identical signed surface.
 */

/** One bundle file for integrity hashing: its bundle-relative path + its bytes. */
export interface BundleFile {
    /** Forward-slashed, bundle-relative path (e.g. 'tools.cjs', 'lib/x.js'). */
    path: string;
    bytes: Uint8Array;
}

/** The plugin manifest filename (mirrors `PLUGIN_MANIFEST_FILENAME` in manifest.ts). */
export const PLUGIN_MANIFEST_FILENAME: string;

/**
 * Collect the plugin's CODE files (for integrity hashing): recurse the dir, skip
 * `.git` + `node_modules`, and skip the manifest + any detached `*.sig`.
 */
export function collectBundleFiles(dir: string): BundleFile[];
