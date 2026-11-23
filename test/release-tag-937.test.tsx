import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { commitMatches, defaultTagFor, judgeReleaseDecision, releaseDecisionPath, repoCallNeedsOwner } from '../src/core/release-tag.js';
import { repoTagRelease } from '../src/main/repo-git.js';
import { repoCall, type PanelsHostDeps } from '../src/main/official-panels-host.js';
import type { TynnBoardPorts } from '../src/main/tynn-board-client.js';
import { RepoChangesView, TagReleaseForm } from '../src/renderer/components/RepoChangesPanel.js';

/**
 * PM G-4 (Tynn #937; spec pm-model.md row G-4, §17 answer 2): GENIE REFUSES TO TAG A RELEASE WITHOUT A SIGNED RELEASE
 * DECISION IN TYNN — for workspaces linked to Tynn only. The Repository panel's "Tag release" asks Tynn (PM-3's read-only
 * door, GET /api/v1/projects/{p}/versions/{v}/release-decision?commit=) for the version the person picked and the EXACT
 * commit being tagged (HEAD's full SHA), and tags only when the decision is signed, holds, is unused, and was signed for
 * that commit. Otherwise it refuses in Tynn's words and makes no tag, locally or on the remote. A workspace with no Tynn
 * link tags as any git does. Measured against a real git, with a directory as the remote.
 */

const HEAD = 'abcdef0123456789abcdef0123456789abcdef01';
const VERSION = { id: 'v1', repository_id: 'r1', number: '0.17.0', release_kind: null, title: 'PM rollout', status: 'active' };
const decision = (over: Record<string, unknown> = {}, top: Record<string, unknown> = {}) => ({
    schema: 'pm-records/1/release',
    version: VERSION,
    required: true,
    decision: {
        required: true, signed: true, valid: true, consumed: false, problem: null, record_id: 'rec1',
        release_commit: HEAD.slice(0, 7), commit_matches: true, signed_by: { id: 'u1', name: 'Owner' }, signed_at: '2026-11-20T00:00:00Z',
        ...over,
    },
    draft: {},
    ...top,
});

describe('judging Tynn\'s release decision (pure)', () => {
    it('asks the version\'s own door, with the exact commit', () => {
        expect(releaseDecisionPath('p 1', 'v/1', HEAD)).toBe(`/api/v1/projects/p%201/versions/v%2F1/release-decision?commit=${HEAD}`);
    });

    it('a signed, valid, unused decision for this version and this commit lets the tag through', () => {
        expect(judgeReleaseDecision(decision(), { versionId: 'v1', commit: HEAD })).toEqual({ ok: true, required: true, versionNumber: '0.17.0', recordId: 'rec1', signedBy: 'Owner' });
    });

    it('ACCEPTANCE 1: where Tynn requires one, no signed decision is refused with the reason', () => {
        const r = judgeReleaseDecision(decision({ signed: false, valid: false, record_id: null, release_commit: null, commit_matches: null }), { versionId: 'v1', commit: HEAD });
        expect(r).toMatchObject({ ok: false, reason: expect.stringContaining('no signed release decision for version 0.17.0') });
    });

    it('Tynn\'s required:false (the repository has not opted into the release rules) lets the tag through, saying none was required', () => {
        const unsigned = judgeReleaseDecision(decision({ required: false, signed: false, valid: false, record_id: null, release_commit: null, commit_matches: null }, { required: false }), { versionId: 'v1', commit: HEAD });
        expect(unsigned).toEqual({ ok: true, required: false, versionNumber: '0.17.0', recordId: null, signedBy: null });
        // Not required is not required: a decision signed for another commit does not turn it into a refusal.
        expect(judgeReleaseDecision(decision({ required: false, release_commit: 'fff9999', commit_matches: false }, { required: false }), { versionId: 'v1', commit: HEAD })).toMatchObject({ ok: true, required: false });
        // It is still the version asked about (CONTROL: another version's answer is refused, required or not).
        expect(judgeReleaseDecision(decision({ required: false }, { required: false, version: { ...VERSION, id: 'v2' } }), { versionId: 'v1', commit: HEAD }).ok).toBe(false);
    });

    it('fails closed on an answer that says neither required nor a decision', () => {
        const { required: _r, ...noRequired } = decision();
        expect(judgeReleaseDecision({ ...noRequired, decision: undefined }, { versionId: 'v1', commit: HEAD }).ok).toBe(false);
        expect(judgeReleaseDecision({ ...noRequired, required: 'no', decision: undefined }, { versionId: 'v1', commit: HEAD }).ok).toBe(false);
        expect(judgeReleaseDecision({ schema: 'pm-records/1/release', version: VERSION }, { versionId: 'v1', commit: HEAD }).ok).toBe(false);
    });

    it('ACCEPTANCE 2: a decision signed for a different commit is refused, naming both commits', () => {
        const r = judgeReleaseDecision(decision({ release_commit: 'fff9999', commit_matches: false }), { versionId: 'v1', commit: HEAD });
        expect(r).toMatchObject({ ok: false, reason: expect.stringMatching(/signed for commit fff9999, not abcdef0/) });
    });

    it('Genie checks the commit itself too: Tynn saying it matches is not enough when the signed commit is another', () => {
        expect(judgeReleaseDecision(decision({ release_commit: 'fff9999', commit_matches: true }), { versionId: 'v1', commit: HEAD }).ok).toBe(false);
        expect(judgeReleaseDecision(decision({ release_commit: HEAD.slice(0, 7), commit_matches: null }), { versionId: 'v1', commit: HEAD }).ok).toBe(false);
    });

    it('a decision that no longer holds is refused in Tynn\'s own words; a used one is refused', () => {
        const stale = judgeReleaseDecision(decision({ valid: false, problem: { code: 'stale', message: 'The version changed after it was signed.' } }), { versionId: 'v1', commit: HEAD });
        expect(stale).toMatchObject({ ok: false, reason: expect.stringContaining('The version changed after it was signed.') });
        expect(judgeReleaseDecision(decision({ consumed: true }), { versionId: 'v1', commit: HEAD })).toMatchObject({ ok: false, reason: expect.stringContaining('already used') });
    });

    it('an answer for another version, or one that is not a release decision, is refused', () => {
        expect(judgeReleaseDecision(decision({}, { version: { ...VERSION, id: 'v2' } }), { versionId: 'v1', commit: HEAD }).ok).toBe(false);
        expect(judgeReleaseDecision({ message: 'hi' }, { versionId: 'v1', commit: HEAD }).ok).toBe(false);
        expect(judgeReleaseDecision(null, { versionId: 'v1', commit: HEAD }).ok).toBe(false);
    });

    it('commits compare as Tynn compares them: case-insensitive, a 7+ prefix matches the full SHA, shorter never', () => {
        expect(commitMatches('ABCDEF0', HEAD)).toBe(true);
        expect(commitMatches(HEAD, 'abcdef0')).toBe(true);
        expect(commitMatches('abcdef', HEAD)).toBe(false);
        expect(commitMatches('abcdef1', HEAD)).toBe(false);
        expect(commitMatches(null, HEAD)).toBe(false);
    });

    it('the tag offered for a version is v + its number', () => {
        expect(defaultTagFor('0.17.0')).toBe('v0.17.0');
        expect(defaultTagFor('v2.0.0-beta.66')).toBe('v2.0.0-beta.66');
        expect(defaultTagFor(null)).toBe('');
    });

    it('tagging is the host owner\'s: repo.call tag / tagOptions need the owner, its other ops do not (CONTROL)', () => {
        expect(repoCallNeedsOwner('repo.call', ['tag', 'w', '', 'v1', 'v1'])).toBe(true);
        expect(repoCallNeedsOwner('repo.call', ['tagOptions', 'w', ''])).toBe(true);
        expect(repoCallNeedsOwner('repo.call', ['status', 'w', ''])).toBe(false);
        expect(repoCallNeedsOwner('files.tree', ['tag'])).toBe(false);
    });
});

const run = promisify(execFile);
const ID = ['-c', 'user.email=t@example.invalid', '-c', 'user.name=t'];
let dir: string;
let ws: string;
let origin: string;
const git = async (...args: string[]) => (await run('git', ['-C', ws, ...args])).stdout.trim();
const remoteTags = async () => (await run('git', ['--git-dir', origin, 'tag', '--list'])).stdout.trim();
beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'genie2-tag-937-'));
    origin = join(dir, 'origin.git');
    ws = join(dir, 'ws');
    await run('git', ['init', '--bare', '--quiet', '--initial-branch=main', origin]);
    await run('git', ['init', '--quiet', '--initial-branch=main', ws]);
    await git('config', 'user.email', 't@example.invalid');
    await git('config', 'user.name', 't');
    await git('config', 'core.autocrlf', 'false');
    await writeFile(join(ws, 'a.txt'), 'one\n');
    await git('add', 'a.txt');
    await git(...ID, 'commit', '--quiet', '-m', 'first');
    await git('remote', 'add', 'origin', origin);
    await git('push', '--quiet', '-u', 'origin', 'main');
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe('repoTagRelease, against a real git', () => {
    it('with no gate (an unlinked workspace): an annotated tag on HEAD, pushed to the remote', async () => {
        const head = await git('rev-parse', 'HEAD');
        expect(await repoTagRelease(ws, '', 'v1.0.0', {})).toEqual({ ok: true, value: { tag: 'v1.0.0', commit: head } });
        expect(await git('cat-file', '-t', 'v1.0.0')).toBe('tag');
        expect(await git('rev-list', '-n', '1', 'v1.0.0')).toBe(head);
        expect(await remoteTags()).toBe('v1.0.0');
    });

    it('the gate is asked about HEAD\'s FULL commit; its refusal leaves no tag, here or on the remote', async () => {
        const head = await git('rev-parse', 'HEAD');
        const asked: string[] = [];
        const r = await repoTagRelease(ws, '', 'v1.0.0', { gate: async (commit) => { asked.push(commit); return { ok: false, reason: 'no signed decision' }; } });
        expect(r).toEqual({ ok: false, error: 'no signed decision' });
        expect(asked).toEqual([head]);
        expect(await git('tag', '--list')).toBe('');
        expect(await remoteTags()).toBe('');
    });

    it('a passing gate tags, and the tag message names the decision it was made under', async () => {
        const r = await repoTagRelease(ws, '', 'v0.17.0', { gate: async () => ({ ok: true, required: true, versionNumber: '0.17.0', recordId: 'rec1', signedBy: 'Owner' }) });
        expect(r).toMatchObject({ ok: true });
        expect(await git('tag', '-l', '--format=%(contents)', 'v0.17.0')).toMatch(/Tynn release decision rec1 for version 0\.17\.0, signed by Owner/);
        expect(await remoteTags()).toBe('v0.17.0');
    });

    it('a gate that required no decision tags, and the tag message says none was required', async () => {
        const r = await repoTagRelease(ws, '', 'v0.17.0', { gate: async () => ({ ok: true, required: false, versionNumber: '0.17.0', recordId: null, signedBy: null }) });
        expect(r).toMatchObject({ ok: true });
        const message = await git('tag', '-l', '--format=%(contents)', 'v0.17.0');
        expect(message).toMatch(/Tynn required no release decision for version 0\.17\.0/);
        expect(message).not.toMatch(/Tynn release decision \S+ for version/);
        expect(await remoteTags()).toBe('v0.17.0');
    });

    it('a push git refuses leaves no local tag behind, so trying again is clean', async () => {
        await git('remote', 'set-url', 'origin', join(dir, 'missing.git'));
        const r = await repoTagRelease(ws, '', 'v1.0.0', {});
        expect(r.ok).toBe(false);
        expect(await git('tag', '--list')).toBe('');
    });

    it('a tag name git would not take, or one that reads as an option, is refused before anything runs', async () => {
        let asked = 0;
        const gate = async () => { asked += 1; return { ok: true as const, required: true, versionNumber: null, recordId: null, signedBy: null }; };
        for (const bad of ['', 'has space', '-d', 'a..b', 'end.lock']) {
            expect((await repoTagRelease(ws, '', bad, { gate })).ok).toBe(false);
        }
        expect(asked).toBe(0);
        expect(await git('tag', '--list')).toBe('');
    });

    it('a tag that already exists is git\'s refusal, and the existing tag is untouched', async () => {
        await git(...ID, 'tag', '-a', 'v1.0.0', '-m', 'old');
        const before = await git('rev-parse', 'v1.0.0');
        expect((await repoTagRelease(ws, '', 'v1.0.0', {})).ok).toBe(false);
        expect(await git('rev-parse', 'v1.0.0')).toBe(before);
    });
});

type Call = { path: string; method: string };
function tynn(answers: Record<string, { status: number; body: unknown }>, opts: { signedIn?: boolean } = {}) {
    const calls: Call[] = [];
    const ports: TynnBoardPorts = {
        signedIn: () => opts.signedIn ?? true,
        projectFor: () => 'p1',
        request: async (path, init) => {
            calls.push({ path, method: init.method });
            const key = Object.keys(answers).find((k) => path.startsWith(k));
            const a = key ? answers[key]! : { status: 404, body: {} };
            return { ok: a.status >= 200 && a.status < 300, status: a.status, json: async () => a.body };
        },
    };
    return { ports, calls };
}
const deps = (ports: TynnBoardPorts | null): PanelsHostDeps => ({ workspacePath: (id) => (id === 'w' ? ws : null), send: async () => {}, now: () => 'now', tynn: async () => ports });
const link = () => writeFile(join(ws, 'project.json'), JSON.stringify({ tynn: { projectId: 'p1', project: 'tynn' } }));
const DOOR = '/api/v1/projects/p1/versions/v1/release-decision';
const BOARD = {
    project_id: 'p1', level: 'versions', version_id: null, story_id: null, stories: null, tasks: null, active_version: null, active_story: null,
    versions: [
        { id: 'v0', number: '0.16.0', title: 'Shipped', status: 'released', story_count: 1, stories_done: 1, task_count: 0, tasks_done: 0 },
        { id: 'v1', number: '0.17.0', title: 'PM rollout', status: 'active', story_count: 2, stories_done: 1, task_count: 0, tasks_done: 0 },
    ],
};

describe('the Repository panel\'s Tag release, by workspace (the host)', () => {
    it('ACCEPTANCE 3: an unlinked workspace tags as before, and Tynn is never asked', async () => {
        const t = tynn({});
        expect(await repoCall(deps(t.ports), 'tag', 'w', '', 'v1.0.0', null)).toMatchObject({ ok: true });
        expect(await remoteTags()).toBe('v1.0.0');
        expect(t.calls).toEqual([]);
        expect(await repoCall(deps(t.ports), 'tagOptions', 'w', '')).toMatchObject({ ok: true, value: { linked: false, versions: [] } });
    });

    it('ACCEPTANCE 1 (linked): no signed decision is refused with Tynn\'s reason, and no tag is made', async () => {
        await link();
        await git('add', 'project.json'); await git(...ID, 'commit', '--quiet', '-m', 'link');
        const t = tynn({ [DOOR]: { status: 200, body: decision({ signed: false, valid: false, record_id: null, release_commit: null, commit_matches: null }) } });
        const r = await repoCall(deps(t.ports), 'tag', 'w', '', 'v0.17.0', 'v1');
        expect(r).toMatchObject({ ok: false, error: expect.stringContaining('no signed release decision') });
        expect(t.calls).toEqual([{ path: `${DOOR}?commit=${await git('rev-parse', 'HEAD')}`, method: 'GET' }]);
        expect(await git('tag', '--list')).toBe('');
        expect(await remoteTags()).toBe('');
    });

    it('ACCEPTANCE 2 (linked): a decision for a different commit is refused; one for HEAD tags (CONTROL)', async () => {
        await link();
        const head = await git('rev-parse', 'HEAD');
        const other = tynn({ [DOOR]: { status: 200, body: decision({ release_commit: 'fff9999', commit_matches: false }) } });
        expect(await repoCall(deps(other.ports), 'tag', 'w', '', 'v0.17.0', 'v1')).toMatchObject({ ok: false, error: expect.stringContaining('fff9999') });
        expect(await git('tag', '--list')).toBe('');
        const signed = tynn({ [DOOR]: { status: 200, body: decision({ release_commit: head.slice(0, 7).toUpperCase(), commit_matches: true }) } });
        expect(await repoCall(deps(signed.ports), 'tag', 'w', '', 'v0.17.0', 'v1')).toEqual({ ok: true, value: { tag: 'v0.17.0', commit: head } });
        expect(await remoteTags()).toBe('v0.17.0');
    });

    it('linked, but Tynn says no decision is required (repository not opted in): tags as an unlinked workspace would', async () => {
        await link();
        const head = await git('rev-parse', 'HEAD');
        const t = tynn({ [DOOR]: { status: 200, body: decision({ required: false, signed: false, valid: false, record_id: null, release_commit: null, commit_matches: null }, { required: false }) } });
        expect(await repoCall(deps(t.ports), 'tag', 'w', '', 'v0.17.0', 'v1')).toEqual({ ok: true, value: { tag: 'v0.17.0', commit: head } });
        expect(t.calls).toEqual([{ path: `${DOOR}?commit=${head}`, method: 'GET' }]);
        expect(await remoteTags()).toBe('v0.17.0');
    });

    it('linked fails closed: no version chosen, signed out of Tynn, no Tynn account, Tynn refusing or unreachable', async () => {
        await link();
        const ok = tynn({ [DOOR]: { status: 200, body: decision() } });
        expect(await repoCall(deps(ok.ports), 'tag', 'w', '', 'v0.17.0', null)).toMatchObject({ ok: false, error: expect.stringMatching(/choose the Tynn version/i) });
        expect(await repoCall(deps(tynn({ [DOOR]: { status: 200, body: decision() } }, { signedIn: false }).ports), 'tag', 'w', '', 'v0.17.0', 'v1')).toMatchObject({ ok: false, error: expect.stringMatching(/not signed in to Tynn/i) });
        expect(await repoCall(deps(null), 'tag', 'w', '', 'v0.17.0', 'v1')).toMatchObject({ ok: false });
        expect(await repoCall(deps(tynn({}).ports), 'tag', 'w', '', 'v0.17.0', 'v1')).toMatchObject({ ok: false });
        const down: TynnBoardPorts = { signedIn: () => true, projectFor: () => 'p1', request: async () => { throw new Error('getaddrinfo ENOTFOUND tynn.ai'); } };
        expect(await repoCall(deps(down), 'tag', 'w', '', 'v0.17.0', 'v1')).toMatchObject({ ok: false, error: expect.stringContaining('ENOTFOUND') });
        expect(await git('tag', '--list')).toBe('');
        expect(ok.calls).toEqual([]);
    });

    it('a linked workspace\'s sub-repo is gated by the envelope\'s link', async () => {
        const sub = join(ws, 'repos', 'app');
        await mkdir(sub, { recursive: true });
        await run('git', ['init', '--quiet', '--initial-branch=main', sub]);
        await writeFile(join(sub, 'x.txt'), 'x\n');
        await run('git', ['-C', sub, 'add', 'x.txt']);
        await run('git', ['-C', sub, ...ID, 'commit', '--quiet', '-m', 'x']);
        await link();
        const t = tynn({});
        expect(await repoCall(deps(t.ports), 'tag', 'w', 'repos/app', 'v0.17.0', 'v1')).toMatchObject({ ok: false });
        expect(t.calls.length).toBe(1);
        expect((await run('git', ['-C', sub, 'tag', '--list'])).stdout.trim()).toBe('');
    });

    it('tagOptions for a linked workspace: linked, HEAD, and the versions still to release (not released ones)', async () => {
        await link();
        const t = tynn({ '/api/v1/projects/p1/board': { status: 200, body: BOARD } });
        const r = await repoCall(deps(t.ports), 'tagOptions', 'w', '');
        expect(r).toEqual({ ok: true, value: { linked: true, head: await git('rev-parse', 'HEAD'), versions: [{ id: 'v1', number: '0.17.0', title: 'PM rollout', status: 'active' }], reason: null } });
    });
});

describe('the Tag release form (react-fancy)', () => {
    const status = { branch: 'main', upstream: 'origin/main', ahead: 0, behind: 0, detached: false, changes: [] };
    const base = { repos: [{ rel: '', name: 'w' }], repoRel: '', status, selected: [], diff: null, busy: false, error: null, notice: null, draft: { message: '' }, on: {} };

    it('the header offers Tag release', () => {
        expect(renderToStaticMarkup(<RepoChangesView {...base} />)).toContain('data-action="repo-tag"');
    });

    it('linked: the Tynn version to release, its tag prefilled, and the commit Tynn must have signed', () => {
        const html = renderToStaticMarkup(<TagReleaseForm options={{ linked: true, head: HEAD, versions: [{ id: 'v1', number: '0.17.0', title: 'PM rollout', status: 'active' }], reason: null }} busy={false} onTag={() => {}} onCancel={() => {}} />);
        expect(html).toContain('data-tag-version-picker=""');
        expect(html).toContain('value="v0.17.0"');
        expect(html).toContain('data-tag-head="abcdef0"');
        expect(html).toContain('data-action="repo-tag-submit"');
        expect(html).toMatch(/signed release decision/);
    });

    it('linked with nothing Tynn can offer: says why, and Tag is not offered', () => {
        const html = renderToStaticMarkup(<TagReleaseForm options={{ linked: true, head: HEAD, versions: [], reason: 'Genie is not signed in to Tynn.' }} busy={false} onTag={() => {}} onCancel={() => {}} />);
        expect(html).toContain('Genie is not signed in to Tynn.');
        expect(html).toMatch(/data-action="repo-tag-submit"[^>]*disabled|disabled[^>]*data-action="repo-tag-submit"/);
    });

    it('unlinked: just the tag name; no Tynn version picker', () => {
        const html = renderToStaticMarkup(<TagReleaseForm options={{ linked: false, head: HEAD, versions: [], reason: null }} busy={false} onTag={() => {}} onCancel={() => {}} />);
        expect(html).not.toContain('data-tag-version-picker');
        expect(html).toContain('data-action="repo-tag-submit"');
    });
});
