import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { artboardRead, artboardReview, repoCall, workspaceRepos } from '../src/main/official-panels-host.js';

/**
 * WHAT THE OFFICIAL PANELS ASK OF THE HOST, BY WORKSPACE (beta.33 item 14). The renderer names a workspace, never a host path;
 * a workspace Genie does not have is refused in words. The Repository panel's repo picker: the workspace itself when it is a
 * repository, then each repo of the envelope's `repos[]` that is checked out.
 */

const run = promisify(execFile);
let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'genie2-panels-host-')); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
const deps = () => ({ workspacePath: (id: string) => (id === 'tynn' ? root : null), send: async () => {}, now: () => 'now' });

describe('the official panels\' host calls', () => {
    it('the repo picker: the envelope itself, then its checked-out repos (one not checked out is not offered)', async () => {
        await run('git', ['init', '--quiet', root]);
        await mkdir(join(root, 'repos', 'app'), { recursive: true });
        await run('git', ['init', '--quiet', join(root, 'repos', 'app')]);
        await writeFile(join(root, 'project.json'), JSON.stringify({ repos: [{ name: 'App', slug: 'app', path: 'repos/app' }, { name: 'Gone', slug: 'gone', path: 'repos/gone' }, { name: 'Host', slug: 'host', path: '.' }] }));
        const repos = await workspaceRepos(root);
        expect(repos.map((r) => r.rel)).toEqual(['', 'repos/app']);
        expect(repos[1]).toEqual({ rel: 'repos/app', name: 'App' });
        expect(await repoCall(deps(), 'list', 'tynn', '')).toMatchObject({ ok: true, value: repos });
    });

    it('a workspace Genie does not have, or an op the panel does not offer, is refused in words', async () => {
        expect(await repoCall(deps(), 'status', 'nope', '')).toEqual({ ok: false, error: 'Genie does not have that workspace' });
        expect(await repoCall(deps(), 'reset', 'tynn', '')).toEqual({ ok: false, error: 'the repository panel has no "reset"' });
        expect(await artboardRead(deps(), 'nope')).toEqual({ posts: [], error: 'Genie does not have that workspace' });
        expect(await artboardReview(deps(), 'tynn', 'x', 'maybe', null)).toEqual({ ok: false, error: 'bad arguments' });
    });

    it('an empty board reads as no posts, not an error', async () => {
        expect(await artboardRead(deps(), 'tynn')).toEqual({ posts: [] });
    });
});
