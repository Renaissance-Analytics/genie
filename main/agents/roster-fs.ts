import fs from 'node:fs';
import type { AgentFilesFs } from './roster';

/**
 * The real filesystem behind {@link agentFilesIn}.
 *
 * Separated from `roster.ts` for the reason every seam in `dev-server` is: the
 * decisions — which folder is an agent, which one may be adopted, what a file
 * says it is for — are pure and asserted against a fake tree, and this is the
 * three lines that cannot be. It is also what keeps `roster.ts` free of `node:fs`
 * so the renderer can read its types.
 *
 * TOTAL, like `ToolchainFs`: a directory that is not there is an empty answer,
 * not a throw. That is the ordinary state here — this feature exists for
 * workspaces whose folder has moved, been unmounted, or arrived on a machine
 * that has never seen them.
 */
export const nodeAgentFilesFs: AgentFilesFs = {
    listDirs(dir: string): string[] {
        try {
            return fs
                .readdirSync(dir, { withFileTypes: true })
                .filter((e) => e.isDirectory())
                .map((e) => e.name);
        } catch {
            return [];
        }
    },
    readFile(file: string): string | null {
        try {
            return fs.readFileSync(file, 'utf8');
        } catch {
            return null;
        }
    },
};
