/**
 * The OFFICIAL (curated, Genie-maintained) plugin list for the Settings →
 * Plugins "Official" tab.
 *
 * The signed, integrity-pinned production curation is Phase 3 (§12.3); Phase 0
 * ships the curated list EMPTY (owner to populate with real repos + a signing
 * authority) plus a bundled "Hello World" dev example so the loader seam is
 * demonstrable in the real app without coining any external URL or name.
 *
 * The example is MATERIALISED to `<userData>/plugins/.examples/` from embedded
 * strings (mirroring the in-repo fixture at `examples/hello-world/`) so it exists
 * on disk in both dev and packaged builds, then installed via the folder path.
 */

import fs from 'fs';
import path from 'path';
import { app } from 'electron';

/** A curated Official plugin entry (installed from its signed repo). */
export interface OfficialPluginEntry {
    id: string;
    name: string;
    description: string;
    /** The git repo URL Genie installs from (signed/pinned in Phase 3). */
    repo: string;
}

/**
 * Curated Official plugins. EMPTY in Phase 0 — the owner sets the real curated
 * repos + the signing authority as part of Phase 3. (Do not invent URLs/names.)
 */
export const OFFICIAL_PLUGINS: OfficialPluginEntry[] = [];

const HELLO_MANIFEST = `{
  "id": "ai.genie.hello-world",
  "namespace": "hello",
  "name": "Hello World",
  "version": "0.1.0",
  "description": "A trivial dev plugin that registers a single greeting tool — proves the Genie plugin loader seam end-to-end.",
  "publisher": { "name": "Genie" },
  "engines": { "genie": ">=0.7.0" },
  "entry": { "tools": "tools.cjs" },
  "mcpTools": [
    {
      "name": "greet",
      "description": "Return a friendly greeting. Pass an optional name to personalise it.",
      "inputSchema": { "type": "object", "properties": { "name": { "type": "string" } }, "additionalProperties": false },
      "run": "tools",
      "process": "worker",
      "gated": false
    }
  ],
  "editors": [],
  "capabilities": { "fs": { "scope": "none" }, "network": { "hosts": [] }, "genieApi": [] }
}
`;

const HELLO_TOOLS = `'use strict';
module.exports = {
    async greet(args) {
        const who = args && typeof args.name === 'string' && args.name.trim() ? args.name.trim() : 'world';
        return { content: [{ type: 'text', text: 'Hello, ' + who + '! — from the Genie Hello World plugin.' }] };
    },
};
`;

export interface BundledExample {
    id: string;
    name: string;
    description: string;
    /** The materialised folder path a folder-install can consume. */
    path: string;
}

/** Materialise the bundled Hello World example to userData and return its path. */
export function materialiseBundledExample(): BundledExample {
    const dir = path.join(app.getPath('userData'), 'plugins', '.examples', 'hello-world');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'genie-plugin.json'), HELLO_MANIFEST);
    fs.writeFileSync(path.join(dir, 'tools.cjs'), HELLO_TOOLS);
    return {
        id: 'ai.genie.hello-world',
        name: 'Hello World',
        description: 'Bundled dev example — registers one greeting tool. Installs from a materialised local folder.',
        path: dir,
    };
}
