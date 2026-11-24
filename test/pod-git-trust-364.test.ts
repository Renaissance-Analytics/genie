import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { canonicalize } from '../src/core/jcs.js';
import { GIT_NEEDS_TRUST, setGitReadPolicy, trustAwarePolicy } from '../src/main/git-read-policy.js';
import { runGit } from '../src/main/proof-of-done-host.js';
import { ProofOfDone, type PendingNote, type PodPorts } from '../src/main/proof-of-done.js';

/**
 * PROOF-OF-DONE'S GIT GOES THROUGH GENIE'S GIT SAFETY (Tynn #364). The host writes each signed PoD as a git note and pushes
 * the notes ref, in the workspace's own folder. A folder's own git config can name a program (`core.sshCommand` runs on a
 * push over ssh, `core.fsmonitor` on a status), so in a workspace the person has not trusted, a folder whose config holds a
 * key that could run something gets no git at all, as every other git read of Genie's (git-read-policy.ts). It says why
 * in the log. Real git, a real repository, a real program that leaves a mark when it runs; every "nothing ran" has a
 * control where it did.
 */

let root: string;
let repo: string;
let mark: string;
let tool: string;
const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], { cwd: repo, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
const ran = () => existsSync(mark);
const untrusted = () => setGitReadPolicy(trustAwarePolicy(() => false));
const trusted = () => setGitReadPolicy(trustAwarePolicy(() => true));

beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'pod-git-364-'));
    mark = join(root, 'mark.txt');
    repo = join(root, 'repo');
    mkdirSync(repo);
    git('init', '-q');
    writeFileSync(join(repo, 'a.txt'), 'one\n');
    git('add', '.');
    git('commit', '-q', '-m', 'first');
    const file = join(root, 'tool.sh');
    writeFileSync(file, `#!/bin/sh\necho ran > '${mark.replace(/\\/g, '/')}'\nexit 1\n`);
    chmodSync(file, 0o755);
    tool = file.replace(/\\/g, '/');
    // A push over ssh runs core.sshCommand. The host is never reached: the program is what runs first.
    git('remote', 'add', 'origin', 'ssh://git@example.invalid/acme/widgets.git');
});
afterEach(() => {
    setGitReadPolicy(null);
    rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

describe("runGit, proof-of-done's git", () => {
    it('a key that could run something, untrusted: push runs nothing, and says why', async () => {
        git('config', 'core.sshCommand', tool);
        untrusted();
        const pushed = await runGit(repo, ['push', 'origin', 'refs/notes/proof-of-done:refs/notes/proof-of-done']);
        expect(ran()).toBe(false);
        expect(pushed).toMatchObject({ ok: false, error: GIT_NEEDS_TRUST });
    });

    it('notes and cat-file are refused there too', async () => {
        const sha = git('rev-parse', 'HEAD');
        git('config', 'core.fsmonitor', tool);
        untrusted();
        expect(await runGit(repo, ['cat-file', '-e', `${sha}^{commit}`])).toMatchObject({ ok: false, error: GIT_NEEDS_TRUST });
        expect(await runGit(repo, ['notes', '--ref=proof-of-done', 'add', '-f', '-m', 'x', sha])).toMatchObject({ ok: false, error: GIT_NEEDS_TRUST });
        expect(git('notes', '--ref=proof-of-done', 'list')).toBe('');
        expect(ran()).toBe(false);
    });

    it('CONTROL: the same repository, trusted: the push runs the program, as git does', async () => {
        git('config', 'core.sshCommand', tool);
        trusted();
        await runGit(repo, ['push', 'origin', 'refs/notes/proof-of-done:refs/notes/proof-of-done']);
        expect(ran()).toBe(true);
    });

    it('CONTROL: a plain repository, untrusted: nothing in it could run, so the note is written', async () => {
        const sha = git('rev-parse', 'HEAD');
        untrusted();
        expect(await runGit(repo, ['cat-file', '-e', `${sha}^{commit}`])).toMatchObject({ ok: true });
        expect(await runGit(repo, ['notes', '--ref=proof-of-done', 'add', '-f', '-m', 'x', sha])).toMatchObject({ ok: true });
        expect(git('notes', '--ref=proof-of-done', 'list')).toContain(sha);
    });
});

describe('a signed claim whose commit is in an untrusted workspace with such a key', () => {
    function pod(): { pod: ProofOfDone; logs: string[]; owed: () => PendingNote[] } {
        const sha = git('rev-parse', 'HEAD');
        const claim = { v: 'pod/1', request: { system: 'tynn', project: 'p1', task: 7 }, work: { repo: 'acme/widgets', commits: [sha] }, score: { value: '0.800', checkpoint: 'C5' }, nonce: 'n1' };
        const hash = createHash('sha256').update(canonicalize(claim), 'utf8').digest().toString('base64url');
        const secrets = new Map<string, string>();
        const logs: string[] = [];
        let owed: PendingNote[] = [];
        let keyId = '';
        const ports: PodPorts = {
            keychain: { get: async (name) => (secrets.has(name) ? { kind: 'value', value: secrets.get(name)! } : { kind: 'missing' }), set: async (name, value) => { secrets.set(name, value); return { ok: true }; } },
            tynn: {
                signedIn: () => true,
                userId: () => 'u1',
                request: async (path, init) => {
                    if (path === '/api/v1/pod/host-keys') {
                        const raw = Buffer.from(String((init.body as { public_key: string }).public_key), 'base64url');
                        keyId = createHash('sha256').update(raw).digest().subarray(0, 16).toString('hex');
                        return { ok: true, status: 201, json: async () => ({}) };
                    }
                    if (path === '/api/v1/pod/pending') return { ok: true, status: 200, json: async () => ({ data: [{ id: 'pod-1', approval: 'agent', host_key_id: keyId, claim, claim_hash: hash }] }) };
                    if (path.endsWith('/signature')) return { ok: true, status: 200, json: async () => ({ data: { token: 'pod1.HASH.SIG' } }) };
                    return { ok: false, status: 404, json: async () => null };
                },
            },
            approve: async () => 'allowed',
            workspaces: () => [{ id: 'acme', path: repo }],
            git: runGit,
            retry: { load: async () => owed, save: async (notes) => { owed = [...notes]; } },
            label: () => 'Desk',
            log: (line) => { logs.push(line); },
        };
        return { pod: new ProofOfDone(ports), logs, owed: () => owed };
    }

    it('no git runs there: nothing ran, the note is kept for later, and the log says why', async () => {
        git('config', 'core.sshCommand', tool);
        git('config', 'core.fsmonitor', tool);
        untrusted();
        const r = pod();
        await r.pod.tick();
        await r.pod.idle();
        expect(ran()).toBe(false);
        expect(git('notes', '--ref=proof-of-done', 'list')).toBe('');
        expect(r.owed().map((n) => n.stage)).toEqual(['note']);
        expect(r.logs.join('\n')).toContain(GIT_NEEDS_TRUST);
    });

    it('CONTROL: trusted, the note is written and the push runs the program', async () => {
        git('config', 'core.sshCommand', tool);
        trusted();
        const r = pod();
        await r.pod.tick();
        await r.pod.idle();
        expect(git('notes', '--ref=proof-of-done', 'list')).not.toBe('');
        expect(ran()).toBe(true);
    });
});
