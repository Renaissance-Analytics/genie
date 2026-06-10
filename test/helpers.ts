import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { simpleGit } from 'simple-git';

/**
 * Create a fresh tmp directory under the OS temp area and return its
 * absolute path. Suite-scoped so a per-test cleanup helper can remove
 * everything in one sweep without tracking individual paths.
 */
const TMP_ROOT = path.join(
    os.tmpdir(),
    `genie-vitest-${process.pid}-${Date.now()}`,
);

export function makeTmpDir(label = 'd'): string {
    const dir = path.join(TMP_ROOT, `${label}-${Math.random().toString(36).slice(2, 10)}`);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

export function cleanupTmpRoot(): void {
    try {
        fs.rmSync(TMP_ROOT, { recursive: true, force: true });
    } catch {
        /* best effort — Windows sometimes holds file handles briefly */
    }
}

/**
 * Initialize a minimal git repo in `dir` with one commit so simple-git's
 * `submoduleAdd` accepts it as a source. Sets a local user.name/email so
 * the commit works regardless of the host's global git config.
 */
export async function seedGitRepo(dir: string, file = 'README.md'): Promise<void> {
    const git = simpleGit(dir);
    await git.init(['--initial-branch=main']);
    await git.addConfig('user.email', 'genie-test@example.com');
    await git.addConfig('user.name', 'Genie Test');
    fs.writeFileSync(path.join(dir, file), '# seed\n');
    await git.add('.');
    await git.commit('seed');
}
