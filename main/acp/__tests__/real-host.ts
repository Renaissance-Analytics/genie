import fs from 'node:fs';
import path from 'node:path';

/**
 * OUR ACP host on disk — shared by the two real-handshake files, and NOT a test file.
 *
 * It lived in `handshake.real.test.ts` and was exported from there. `handshake-codex.real.test.ts`
 * imported it, which **executed that file's describes inside the codex run** — so every pass spent a
 * second real turn on the owner's Claude subscription to resolve one path. Caught by reading the
 * verbose reporter, which listed the claude cases twice.
 *
 * A `.ts` without `.test.` in the name, so vitest's include pattern does not collect it.
 *
 * prism-acp ships NO `bin` — it is an ESM library — so there is no package entry to resolve. Genie
 * owns the entry, which is also what removes the `.cmd`-shim hazard: a published shim re-enters
 * whatever `node` is first on PATH and defeats the runtime choice.
 */
export function hostScriptOf(): string | null {
    try {
        const script = path.join(process.cwd(), 'main', 'acp', 'prism-host.mjs');
        if (!fs.existsSync(script)) return null;
        // The library it imports must be installed too, or the host dies on its first line — which
        // is exactly how a bad import in that script took the claude handshake down with it.
        const lib = path.join(
            process.cwd(),
            'node_modules',
            '@particle-academy',
            'prism-acp',
            'package.json',
        );
        return fs.existsSync(lib) ? script : null;
    } catch {
        return null;
    }
}
