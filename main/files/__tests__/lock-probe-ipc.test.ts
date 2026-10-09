import fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { existingFiles } from '../ipc';
import { cleanupTmpRoot, makeTmpDir } from '../../../test/helpers';
import { repoLockNotice, repoLockState } from '../../../renderer/lib/file-panel-states';
import { LOCK_PROBE_PATHS, lockProbe } from '../../../renderer/lib/file-panel-signals';

/**
 * THE LOCK PROBE AGAINST THE REAL IPC, on a real filesystem.
 *
 * `lockProbe` is built on a claim about somebody else's code — that `files.exist` returns FILES
 * only, so `.git` comes back in a worktree and `.git/HEAD` comes back in a normal repo. A
 * proposed fix is a hypothesis: if that claim is wrong in either direction the probe inverts,
 * and it inverts toward the dangerous answer (a lock reported as absent). So the two layouts
 * are built on disk here and the REAL `existingFiles` is asked, rather than a hand-made list
 * standing in for it.
 *
 * `.git` is written by hand rather than by `git init`: a directory with a `HEAD` file in it and
 * a `gitdir:` pointer file are exactly the two shapes that matter, and building them directly
 * keeps the measurement about the probe instead of about git's version.
 */

afterAll(() => cleanupTmpRoot());

/** What the panel's effect does: ask for the probe paths, read the answer. */
const probe = async (workspace: string, at = 0) =>
    lockProbe(await existingFiles(workspace, [...LOCK_PROBE_PATHS]), at);

describe('the lock probe · measured against the real files.exist', () => {
    it('MEASURES the lock in a repo whose .git is a directory', async () => {
        const dir = makeTmpDir('lock-real-repo');
        fs.mkdirSync(path.join(dir, '.git'));
        fs.writeFileSync(path.join(dir, '.git', 'HEAD'), 'ref: refs/heads/main\n');

        // No lock on the floor — and this `false` is EARNED: `.git/HEAD` came back, which is
        // what proves the call could read inside `.git`.
        expect(await probe(dir)).toEqual({ at: 0, present: false });
        expect(repoLockState([await probe(dir)]).kind).toBe('none');

        // POSITIVE CONTROL: put the lock there and the same probe finds it. Without this the
        // `false` above would also pass on a probe that can see nothing.
        fs.writeFileSync(path.join(dir, '.git', 'index.lock'), '');
        expect(await probe(dir, 1_000)).toEqual({ at: 1_000, present: true });

        // Two sightings 11s apart is the stale state the chip reports, with the fix naming the
        // file that was actually probed.
        const stale = repoLockState([await probe(dir, 0), await probe(dir, 11_000)]);
        expect(stale.kind).toBe('stale');
        expect(repoLockNotice(stale)).toContain('.git/index.lock');
    });

    it('is BLIND in a worktree, where .git is a gitdir POINTER FILE', async () => {
        // This checkout is itself one of these: a 75-byte `.git` file. The real git dir lives
        // outside the workspace root, where `guardedResolve` will not follow.
        const dir = makeTmpDir('lock-real-worktree');
        fs.writeFileSync(path.join(dir, '.git'), 'gitdir: C:/elsewhere/.git/worktrees/x\n');

        const seen = await probe(dir);
        // `null`, never `false`. A worktree has no visible lock AND no way to say there is none.
        expect(seen.present).toBeNull();
        expect(repoLockState([seen, await probe(dir, 11_000)]).kind).toBe('unseen');
        // And the chip says nothing rather than reporting a clean repo it never read.
        expect(repoLockNotice(repoLockState([seen]))).toBeNull();
    });

    it('is BLIND in a folder that is not a repo, rather than reporting no lock', async () => {
        const dir = makeTmpDir('lock-real-plain');
        fs.writeFileSync(path.join(dir, 'README.md'), '# not a repo\n');
        expect((await probe(dir)).present).toBeNull();
    });

    it('CONFIRMS the assumption the probe rests on: a directory never comes back', async () => {
        // The load-bearing behaviour of `existingFiles`, measured here because `lockProbe`
        // reads a returned `.git` as "this is a pointer file" and nothing else would tell it.
        const dir = makeTmpDir('lock-real-dirs');
        fs.mkdirSync(path.join(dir, '.git'));
        fs.writeFileSync(path.join(dir, '.git', 'HEAD'), 'ref: refs/heads/main\n');
        const found = await existingFiles(dir, [...LOCK_PROBE_PATHS]);
        expect(found).not.toContain('.git');
        // POSITIVE CONTROL: the file inside that same directory DOES come back, so the absence
        // above is the directory rule and not a call that returned nothing.
        expect(found).toContain('.git/HEAD');
    });
});
