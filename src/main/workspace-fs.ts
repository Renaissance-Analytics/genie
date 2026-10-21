import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { gitFirstCommit, gitInit } from './git-ports.js';
import type { WorkspaceOpsPorts } from './workspace-ops-host.js';

/**
 * THE REAL FILESYSTEM THE WORKSPACE OPS WRITE THROUGH (§6.1). main.ts hands these to workspace-ops-host as they are, and
 * the first-commit test drives createWorkspace through the SAME functions against a real folder and a real git — so what
 * the test measures is what the app runs, not a copy of it. The clone is not here: it needs the GitHub sign-in, which
 * main.ts owns.
 */
export function nodeWorkspaceFs(): Omit<WorkspaceOpsPorts['fs'], 'gitClone'> {
    return {
        exists: async (p) => { try { return (await stat(p)).isDirectory(); } catch { return false; } },
        entries: (p) => readdir(p),
        readJson: async (p) => { try { return JSON.parse(await readFile(p, 'utf8')) as unknown; } catch { return null; } },
        writeJson: (p, value) => writeFile(p, `${JSON.stringify(value, null, 2)}\n`, 'utf8'),
        writeText: (p, text) => writeFile(p, text, 'utf8'),
        mkdir: (p) => mkdir(p, { recursive: true }).then(() => {}),
        gitInit,
        gitFirstCommit,
    };
}
