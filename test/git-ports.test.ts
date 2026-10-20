import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { gitClone, gitInit } from '../src/main/git-ports.js';

/**
 * THE REAL GIT (§6.1 add from git; the "real git clone" row of the gap table was Unmeasured). The ports
 * main.ts hands the workspace ops are exercised against a real `git` here, in the test machine: a bare
 * repo made for the test is cloned and the clone has the file; a clone that cannot happen rejects with
 * git's OWN words, not a bare exit code; `gitInit` makes a repository. No network: the "remote" is a
 * directory. git missing on the machine is a loud failure, not a skip — a skip would read as green.
 */

const run = promisify(execFile);
let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'genie2-git-ports-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe('gitClone / gitInit against a real git', () => {
    it('clones a bare repository and the clone carries the committed file', async () => {
        const bare = join(dir, 'origin.git');
        const work = join(dir, 'work');
        // The bare repo's HEAD must name the branch the push creates, or the clone checks out nothing (git 2.43 defaults HEAD to master).
        await run('git', ['init', '--bare', '--quiet', '--initial-branch=main', bare]);
        await run('git', ['init', '--quiet', '--initial-branch=main', work]);
        await writeFile(join(work, 'hello.txt'), 'hello from the origin\n');
        await run('git', ['-C', work, 'add', 'hello.txt']);
        await run('git', ['-C', work, '-c', 'user.email=t@example.invalid', '-c', 'user.name=t', 'commit', '--quiet', '-m', 'first']);
        await run('git', ['-C', work, 'push', '--quiet', bare, 'HEAD:refs/heads/main']);

        const into = join(dir, 'clone');
        await gitClone(bare, into);
        // The claim is that the clone CARRIES the committed file, not what line ending the user's git
        // writes on checkout: a Windows git with core.autocrlf=true (the test VM's) checks out CRLF,
        // and the Windows run proved it — 'hello from the origin\r\n'. Compare the text, not the EOL.
        expect((await readFile(join(into, 'hello.txt'), 'utf8')).replace(/\r\n/g, '\n')).toBe('hello from the origin\n');
        expect(await readdir(into)).toContain('.git');
    }, 30_000); // seven git spawns and a clone: a cold GitHub Windows runner took more than vitest's 5 s (beta.14's release build)

    it('a clone that cannot happen rejects with git’s own words', async () => {
        const into = join(dir, 'nope');
        await expect(gitClone(join(dir, 'does-not-exist.git'), into)).rejects.toThrow(/does not exist|not found|No such file|repository/i);
    }, 30_000);

    /*
     * THE CLONE CREDENTIAL (beta.33 item 25; Genie 1's `githubCloneAuth`): with the person signed in to GitHub, a clone of
     * a repository the App can read carries the token as git config for THIS command only. Genie 1 passed it as `-c`
     * arguments, where every process on the machine can read it in the process list; here it rides git's own
     * GIT_CONFIG_COUNT/KEY/VALUE environment (git ≥ 2.31), which only the same user can read, and nothing is written into
     * the clone's .git/config. Measured against the real git: an `insteadOf` passed this way redirects the clone, which
     * only happens if git applied the config.
     */
    it('config handed to a clone reaches git (an insteadOf redirects it) and is not written into the clone', async () => {
        const bare = join(dir, 'origin.git');
        const work = join(dir, 'work');
        await run('git', ['init', '--bare', '--quiet', '--initial-branch=main', bare]);
        await run('git', ['init', '--quiet', '--initial-branch=main', work]);
        await writeFile(join(work, 'hello.txt'), 'hi\n');
        await run('git', ['-C', work, 'add', 'hello.txt']);
        await run('git', ['-C', work, '-c', 'user.email=t@example.invalid', '-c', 'user.name=t', 'commit', '--quiet', '-m', 'first']);
        await run('git', ['-C', work, 'push', '--quiet', bare, 'HEAD:refs/heads/main']);

        const into = join(dir, 'clone');
        // The URL names a place that does not exist; only the config makes it the bare repo.
        await gitClone('https://example.invalid/ada/private.git', into, { config: [[`url.${bare.replace(/\\/g, '/')}.insteadOf`, 'https://example.invalid/ada/private.git']], secrets: [] });
        expect(await readdir(into)).toContain('hello.txt');
        expect(await readFile(join(into, '.git', 'config'), 'utf8')).not.toContain('insteadOf');
    }, 30_000);

    it('a failing clone’s words have every secret scrubbed out', async () => {
        const secret = 'ghu_exampletoken0000000000000000000000';
        const into = join(dir, 'nope');
        // git names the missing path, secret and all, in its error.
        const error = await gitClone(join(dir, `${secret}.git`), into, { config: [], secrets: [secret] }).then(() => null, (e: Error) => e);
        expect(error).toBeInstanceOf(Error);
        expect(error!.message).toContain('***');
        expect(error!.message).not.toContain(secret);
    }, 30_000);

    it('gitInit makes a repository where there was a folder', async () => {
        const fresh = join(dir, 'fresh');
        await run('git', ['init', '--quiet', dir]); // the parent being a repo must not matter
        await rm(join(dir, '.git'), { recursive: true, force: true });
        await writeFile(join(dir, 'placeholder'), '');
        await mkdir(fresh, { recursive: true });
        await gitInit(fresh);
        expect(await readdir(fresh)).toContain('.git');
    }, 30_000);
});
