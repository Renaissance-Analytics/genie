import fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { simpleGit } from 'simple-git';
import { formatRepoCheckoutLine, repoCheckoutInfo, type RepoCheckoutInfo } from '../repo-checkout';
import { cleanupTmpRoot, makeTmpDir } from '../../../test/helpers';

// Real git subprocesses (init/clone/commit/fetch) — same overhead profile as
// create-agi.test.ts's envelope tests, so give it the same headroom.
afterAll(() => cleanupTmpRoot());

async function initRepo(dir: string): Promise<ReturnType<typeof simpleGit>> {
    const git = simpleGit(dir);
    await git.init(['--initial-branch=main']);
    await git.addConfig('user.email', 'genie-test@example.com');
    await git.addConfig('user.name', 'Genie Test');
    return git;
}

async function commit(git: ReturnType<typeof simpleGit>, dir: string, file: string, msg: string): Promise<void> {
    fs.writeFileSync(path.join(dir, file), `${msg}\n`);
    await git.add('.');
    await git.commit(msg);
}

describe('repoCheckoutInfo — genie#317 (local refs only, no fetch)', () => {
    it('reports current branch, default branch, and ahead/behind vs origin from ALREADY-cached refs', async () => {
        const remote = makeTmpDir('checkout-remote');
        const remoteGit = await initRepo(remote);
        await commit(remoteGit, remote, 'a.txt', 'seed');

        const local = makeTmpDir('checkout-local');
        await simpleGit().clone(remote, local);
        const localGit = simpleGit(local);
        await localGit.addConfig('user.email', 'genie-test@example.com');
        await localGit.addConfig('user.name', 'Genie Test');

        await localGit.checkoutLocalBranch('feat/x');
        await commit(localGit, local, 'b.txt', 'local change 1');
        await commit(localGit, local, 'c.txt', 'local change 2');

        // The remote moves on independently of the clone...
        await commit(remoteGit, remote, 'd.txt', 'remote change 1');
        await commit(remoteGit, remote, 'e.txt', 'remote change 2');
        await commit(remoteGit, remote, 'f.txt', 'remote change 3');
        // ...and the local clone re-syncs its CACHE of the remote's refs. This
        // is the one and only fetch in the test — repoCheckoutInfo itself must
        // never fetch; it only reads what's already on disk after this point.
        await localGit.fetch('origin');

        const info = await repoCheckoutInfo(local);
        expect(info.branch).toBe('feat/x');
        expect(info.detached).toBe(false);
        expect(info.defaultBranch).toBe('main');
        expect(info.isDefaultBranch).toBe(false);
        expect(info.ahead).toBe(2);
        expect(info.behind).toBe(3);
        expect(info.comparedTo).toBe('origin/main');
    });

    it('reports up to date (0 ahead, 0 behind) when the default branch has not diverged', async () => {
        const remote = makeTmpDir('checkout-remote-clean');
        const remoteGit = await initRepo(remote);
        await commit(remoteGit, remote, 'a.txt', 'seed');

        const local = makeTmpDir('checkout-local-clean');
        await simpleGit().clone(remote, local);

        const info = await repoCheckoutInfo(local);
        expect(info.branch).toBe('main');
        expect(info.isDefaultBranch).toBe(true);
        expect(info.ahead).toBe(0);
        expect(info.behind).toBe(0);
        expect(info.comparedTo).toBe('origin/main');
    });

    it('reports detached HEAD (branch: null) rather than a false branch name', async () => {
        const remote = makeTmpDir('checkout-remote-detached');
        const remoteGit = await initRepo(remote);
        await commit(remoteGit, remote, 'a.txt', 'seed');
        const sha = (await remoteGit.revparse(['HEAD'])).trim();
        await commit(remoteGit, remote, 'b.txt', 'second');

        await remoteGit.checkout(sha);
        const info = await repoCheckoutInfo(remote);
        expect(info.detached).toBe(true);
        expect(info.branch).toBeNull();
    });

    it('leaves default/ahead/behind null when there is no origin remote at all', async () => {
        const dir = makeTmpDir('checkout-no-remote');
        const git = await initRepo(dir);
        await commit(git, dir, 'a.txt', 'seed');

        const info = await repoCheckoutInfo(dir);
        expect(info.branch).toBe('main');
        expect(info.defaultBranch).toBeNull();
        expect(info.ahead).toBeNull();
        expect(info.behind).toBeNull();
        expect(info.comparedTo).toBeNull();
    });

    it("reads the repo's own package.json version at HEAD", async () => {
        const dir = makeTmpDir('checkout-version');
        const git = await initRepo(dir);
        fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ version: '0.7.0-beta.265' }));
        await git.add('.');
        await git.commit('add package.json');

        const info = await repoCheckoutInfo(dir);
        expect(info.packageVersion).toBe('0.7.0-beta.265');
    });

    it('leaves packageVersion null when there is no package.json', async () => {
        const dir = makeTmpDir('checkout-no-package');
        const git = await initRepo(dir);
        await commit(git, dir, 'a.txt', 'seed');
        const info = await repoCheckoutInfo(dir);
        expect(info.packageVersion).toBeNull();
    });
});

describe('formatRepoCheckoutLine — pure formatting (genie#317)', () => {
    const base: RepoCheckoutInfo = {
        branch: 'main',
        detached: false,
        defaultBranch: 'main',
        isDefaultBranch: true,
        ahead: 0,
        behind: 0,
        comparedTo: 'origin/main',
        packageVersion: null,
    };

    it('renders "up to date" on the default branch with no drift', () => {
        expect(formatRepoCheckoutLine('genie', base)).toBe(
            'genie — main (default), up to date with origin/main',
        );
    });

    it('renders ahead+behind counts against the compared ref, per genie#317\'s own example shape', () => {
        const info: RepoCheckoutInfo = {
            ...base,
            branch: 'feat/gapp-agents-and-self-update',
            isDefaultBranch: false,
            ahead: 0,
            behind: 178,
            packageVersion: '0.7.0-beta.265',
        };
        expect(formatRepoCheckoutLine('genie', info, '0.7.0-beta.289')).toBe(
            'genie — feat/gapp-agents-and-self-update, 178 behind origin/main (v0.7.0-beta.265; running build is v0.7.0-beta.289)',
        );
    });

    it('shows both ahead and behind when the branch has diverged both ways', () => {
        const info: RepoCheckoutInfo = { ...base, branch: 'feat/x', isDefaultBranch: false, ahead: 2, behind: 3 };
        expect(formatRepoCheckoutLine('genie', info)).toBe(
            'genie — feat/x, 2 ahead, 3 behind origin/main',
        );
    });

    it('omits the version-mismatch note when the running build matches', () => {
        const info: RepoCheckoutInfo = { ...base, packageVersion: '0.7.0-beta.289' };
        expect(formatRepoCheckoutLine('genie', info, '0.7.0-beta.289')).toBe(
            'genie — main (default), up to date with origin/main (v0.7.0-beta.289)',
        );
    });

    it('omits the version parenthetical entirely when there is no package.json', () => {
        expect(formatRepoCheckoutLine('tynn', base)).toBe(
            'tynn — main (default), up to date with origin/main',
        );
    });

    it('reports detached HEAD plainly', () => {
        const info: RepoCheckoutInfo = { ...base, branch: null, detached: true, isDefaultBranch: false };
        expect(formatRepoCheckoutLine('genie', info)).toBe('genie — detached HEAD, up to date with origin/main');
    });

    it("says comparison isn't available when there is no origin default branch locally", () => {
        const info: RepoCheckoutInfo = {
            branch: 'main',
            detached: false,
            defaultBranch: null,
            isDefaultBranch: false,
            ahead: null,
            behind: null,
            comparedTo: null,
            packageVersion: null,
        };
        expect(formatRepoCheckoutLine('local-only', info)).toBe(
            "local-only — main, can't compare to origin's default branch locally",
        );
    });
});
