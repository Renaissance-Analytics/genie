import fs from 'node:fs';
import path from 'node:path';

/**
 * A package's CLI entry, read from its own `bin` field.
 *
 * **Not `require.resolve` of the package root.** That answers with the LIBRARY entry —
 * `@agentclientprotocol/claude-agent-acp` exports `dist/lib.js` there while its bin is
 * `dist/index.js` — so resolving the root would start the wrong file and then hang in the
 * handshake, which reads as a wedged agent.
 *
 * **And not `node_modules/.bin`.** The shim there is `claude-agent-acp.cmd` on Windows, so
 * the bare name does not exist (a real spawn failed ENOENT on exactly that), and running a
 * shim re-enters whatever `node` is first on PATH — which silently defeats choosing the
 * runtime at all.
 *
 * Both of those were found by running it rather than by reading about it.
 */
export function adapterScriptOf(pkg: string, root = process.cwd()): string | null {
    try {
        const manifestPath = path.join(root, 'node_modules', pkg, 'package.json');
        if (!fs.existsSync(manifestPath)) return null;
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
            bin?: Record<string, string> | string;
        };
        const bin = typeof manifest.bin === 'string' ? manifest.bin : Object.values(manifest.bin ?? {})[0];
        if (!bin) return null;
        const script = path.join(path.dirname(manifestPath), bin);
        return fs.existsSync(script) ? script : null;
    } catch {
        // An unreadable or malformed manifest means "not installed" as far as a caller is
        // concerned, and the caller already has a named refusal for that.
        return null;
    }
}
