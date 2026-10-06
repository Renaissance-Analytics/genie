import fs from 'node:fs';
import path from 'node:path';
import { PRISM_HOST_FILENAME } from './agent-spec';

/**
 * Find our ACP host script on disk — `main/acp/prism-host.mjs`.
 *
 * It is spawned as **plain Node** (Electron with `ELECTRON_RUN_AS_NODE=1`), whose module
 * resolution is **not asar-aware**. So in a packaged install the script cannot be read from
 * inside `app.asar` and neither can the ESM library it imports — both are listed in
 * `asarUnpack`, and the unpacked copy is what this must find. That is the same constraint
 * `app/mcp-shuttle.js` and `@particle-academy/fancy-term-host` already carry, for the same
 * reason: *"packed, it would never start for anyone."*
 *
 * Candidates are tried in packaged-first order and each is checked with `existsSync` rather
 * than assumed, so a layout change surfaces as a NAMED refusal (`host-missing`) instead of
 * `node` opening a REPL that never answers the handshake.
 */
export function prismHostPath(root = process.cwd()): string | null {
    const rel = path.join('main', 'acp', PRISM_HOST_FILENAME);

    const candidates = [
        // Packaged: unpacked beside the asar, which is the only copy plain Node can read.
        path.join(root.replace(/app\.asar(?![.])/, 'app.asar.unpacked'), rel),
        // Dev and unpacked-dir builds: straight off the source tree.
        path.join(root, rel),
    ];

    for (const candidate of candidates) {
        if (fs.existsSync(candidate)) return candidate;
    }
    return null;
}
