/**
 * Plugin BUNDLE-FILE collection — the DEP-FREE, SHARED walk (Plugin System, Phase 3).
 *
 * SINGLE SOURCE OF TRUTH for "which files make up a plugin's signed CODE surface".
 * Plain CommonJS using only `fs` / `path` (no Electron, no crypto, no TypeScript)
 * so the app's installer AND the CI signer walk the tree identically — a signature
 * the signer produces covers EXACTLY the files the installer re-hashes, so they
 * can never disagree on "which bytes were signed":
 *
 *   1. the desktop app — `main/plugins/install.ts` imports `collectBundleFiles`
 *      here to recompute integrity at install/enable;
 *   2. the CI signer   — `scripts/sign-plugin.mjs` imports it to hash the same
 *      files before signing;
 *   3. the round-trip test drives both against one fixture.
 *
 * The RULE (kept in lock-step with `computeBundleIntegrity` in `signing-core`):
 * recurse the plugin dir; skip the `.git` + `node_modules` directories; skip the
 * manifest itself (covered by the signature, not the integrity hash) and any
 * detached `*.sig`. Paths are forward-slashed + bundle-relative.
 *
 * @typedef {{ path: string, bytes: Uint8Array }} BundleFile
 */

'use strict';

const fs = require('fs');
const path = require('path');

/**
 * The plugin manifest filename. Mirrors `PLUGIN_MANIFEST_FILENAME` in
 * `manifest.ts` — a stable wire-format constant duplicated here only because this
 * dep-free module cannot import the TypeScript source.
 */
const PLUGIN_MANIFEST_FILENAME = 'genie-plugin.json';

/**
 * Collect the plugin's CODE files (for integrity hashing) from a plugin dir.
 * @param {string} dir
 * @returns {BundleFile[]}
 */
function collectBundleFiles(dir) {
    /** @type {BundleFile[]} */
    const out = [];
    const root = path.resolve(dir);
    /** @param {string} abs */
    const walk = (abs) => {
        for (const ent of fs.readdirSync(abs, { withFileTypes: true })) {
            if (ent.name === '.git' || ent.name === 'node_modules') continue;
            const child = path.join(abs, ent.name);
            if (ent.isDirectory()) {
                walk(child);
                continue;
            }
            if (!ent.isFile()) continue;
            const rel = path.relative(root, child).replace(/\\/g, '/');
            if (rel === PLUGIN_MANIFEST_FILENAME || rel.endsWith('.sig')) continue;
            out.push({ path: rel, bytes: fs.readFileSync(child) });
        }
    };
    walk(root);
    return out;
}

module.exports = { collectBundleFiles, PLUGIN_MANIFEST_FILENAME };
