import { createHash, createPublicKey, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { canonicalize } from '../src/core/jcs.js';
import type { KeychainRead, KeychainResult, SecretName } from '../src/main/keychain.js';
import { POD_KEY_SECRET, ProofOfDone, podKeyId, type PodPorts, type PendingNote } from '../src/main/proof-of-done.js';

/**
 * PROOF-OF-DONE, THE HOST'S HALF (Tynn #742; Tynn #740 is the other). The host keeps one Ed25519 key, registers its public
 * half with the signed-in person's Tynn, signs the claim hashes Tynn asks for (alone when the workflow setting says agents
 * may sign, after the person's Sign when it says HITL), and writes the result as a git note on each attested commit.
 */

const b64u = (b: Buffer | Uint8Array) => Buffer.from(b).toString('base64url');

interface Call { method: string; path: string; body?: unknown }
type Options = { userId?: string | null; pending?: unknown[]; approval?: 'allowed' | 'denied'; keychainFails?: boolean; gitHas?: (cwd: string, sha: string) => boolean; pushOk?: boolean; signStatus?: number; secrets?: Map<string, string> };

const CLAIM = { v: 'pod/1', request: { system: 'tynn', project: 'p1', task: 7, story: 742 }, work: { repo: 'acme/widgets', commits: ['a'.repeat(40), 'b'.repeat(40)] }, score: { value: '0.800', checkpoint: 'C5', next: 'C6' }, nonce: 'n1' };
const hashOf = (claim: unknown) => createHash('sha256').update(canonicalize(claim), 'utf8').digest();

function rig(options: Options = {}) {
    const secrets = options.secrets ?? new Map<string, string>();
    const calls: Call[] = [];
    const logs: string[] = [];
    const asked: string[] = [];
    const gitCalls: Array<{ cwd: string; args: readonly string[] }> = [];
    let userId: string | null = options.userId === undefined ? 'u1' : options.userId;
    let retry: PendingNote[] = [];
    let pushOk = options.pushOk ?? true;
    const ports: PodPorts = {
        keychain: {
            get: async (name: SecretName): Promise<KeychainRead> => options.keychainFails ? { kind: 'unavailable', reason: 'locked' } : secrets.has(name) ? { kind: 'value', value: secrets.get(name)! } : { kind: 'missing' },
            set: async (name: SecretName, value: string): Promise<KeychainResult> => { if (options.keychainFails) return { ok: false, reason: 'locked' }; secrets.set(name, value); return { ok: true }; },
        },
        tynn: {
            signedIn: () => userId !== null,
            userId: () => userId,
            request: async (path, init) => {
                calls.push({ method: init.method, path, ...(init.body !== undefined ? { body: init.body } : {}) });
                if (path === '/api/v1/pod/host-keys') return { ok: true, status: 201, json: async () => ({ data: { key_id: 'x' } }) };
                if (path === '/api/v1/pod/pending') return { ok: true, status: 200, json: async () => ({ data: options.pending ?? [] }) };
                if (/^\/api\/v1\/pod\/[^/]+\/signature$/.test(path)) {
                    const status = options.signStatus ?? 200;
                    return { ok: status < 300, status, json: async () => ({ data: { token: 'pod1.HASH.SIG' } }) };
                }
                return { ok: false, status: 404, json: async () => null };
            },
        },
        approve: async (request) => { asked.push(request.detail); return options.approval ?? 'allowed'; },
        workspaces: () => [{ id: 'w1', path: '/work/widgets' }, { id: 'w2', path: '/work/other' }],
        git: async (cwd, args) => {
            gitCalls.push({ cwd, args });
            if (args[0] === 'cat-file') return options.gitHas?.(cwd, String(args[2]).replace('^{commit}', '')) ? { ok: true, stdout: '' } : { ok: false, stdout: '', error: 'missing' };
            if (args[0] === 'push') return pushOk ? { ok: true, stdout: '' } : { ok: false, stdout: '', error: 'no route' };
            return { ok: true, stdout: '' };
        },
        retry: { load: async () => retry, save: async (notes) => { retry = [...notes]; } },
        label: () => 'Desk',
        log: (line) => { logs.push(line); },
        now: () => 1_000,
    };
    return { pod: new ProofOfDone(ports), ports, secrets, calls, logs, asked, gitCalls, retry: () => retry, setPush: (ok: boolean) => { pushOk = ok; }, setUser: (id: string | null) => { userId = id; } };
}

const item = (over: Record<string, unknown> = {}, claim: unknown = CLAIM) => ({ id: 'pod-1', status: 'pending', approval: 'agent', claim, claim_hash: b64u(hashOf(claim)), issued_at: '2026-11-15T10:00:00Z', ...over });

const posts = (r: ReturnType<typeof rig>) => r.calls.filter((c) => c.path === '/api/v1/pod/host-keys');
const registered = (r: ReturnType<typeof rig>) => posts(r)[0]?.body as { public_key: string; label?: string } | undefined;

/** A host that already has its key: the first rig makes it, the second asks as that same host. */
async function asTheHost(build: (keyId: string) => Options) {
    const seed = rig();
    await seed.pod.tick();
    const publicKey = registered(seed)!.public_key;
    const keyId = podKeyId(Buffer.from(publicKey, 'base64url'));
    const r = rig({ ...build(keyId), secrets: new Map(seed.secrets) });
    return { r, keyId, publicKey };
}

describe('podKeyId', () => {
    it('is hex of the first 16 bytes of SHA-256 of the raw public key', () => {
        const raw = Buffer.alloc(32, 7);
        expect(podKeyId(raw)).toBe(createHash('sha256').update(raw).digest().subarray(0, 16).toString('hex'));
        expect(podKeyId(raw)).toMatch(/^[0-9a-f]{32}$/);
    });
});

describe('the host key', () => {
    it('is made once, kept in the credential store, and registered as base64url raw bytes with its label', async () => {
        const r = rig();
        await r.pod.tick();
        expect(r.secrets.has(POD_KEY_SECRET)).toBe(true);
        const body = registered(r)!;
        expect(Buffer.from(body.public_key, 'base64url')).toHaveLength(32);
        expect(body.public_key).toMatch(/^[A-Za-z0-9_-]+$/);
        expect(body.label).toBe('Desk');
    });

    it('is the same key on the next start, and registering is not repeated while nothing changed', async () => {
        const r = rig();
        await r.pod.tick();
        await r.pod.tick();
        expect(posts(r)).toHaveLength(1);
        const again = new ProofOfDone(r.ports);
        await again.tick();
        expect(posts(r)).toHaveLength(2);
        expect((posts(r)[1]!.body as { public_key: string }).public_key).toBe(registered(r)!.public_key);
    });

    it('is registered again when the signed-in person changes', async () => {
        const r = rig();
        await r.pod.tick();
        r.setUser('u2');
        await r.pod.tick();
        expect(posts(r)).toHaveLength(2);
    });

    it('does nothing at all while signed out', async () => {
        const r = rig({ userId: null });
        await r.pod.tick();
        expect(r.calls).toEqual([]);
        expect(r.secrets.size).toBe(0);
    });

    it('is never kept when the credential store does not answer: no key, no request', async () => {
        const r = rig({ keychainFails: true });
        await r.pod.tick();
        expect(r.calls).toEqual([]);
        expect(r.logs.join('\n')).toMatch(/credential store/i);
    });

    it('never appears in a log line, and nothing writes it to a file (source guard)', async () => {
        const { r } = await asTheHost((k) => ({ pending: [item({ host_key_id: k })] }));
        await r.pod.tick();
        await r.pod.idle();
        expect(r.logs.join('\n')).not.toContain(r.secrets.get(POD_KEY_SECRET)!);
        const source = readFileSync(join(__dirname, '../src/main/proof-of-done.ts'), 'utf8');
        expect(source).not.toMatch(/writeFile|appendFile|createWriteStream/);
    });
});

describe('signing what Tynn asks for', () => {
    it('signs an agent-approved claim alone, with a signature that verifies over the raw 32-byte hash', async () => {
        const { r, keyId, publicKey } = await asTheHost((k) => ({ pending: [item({ host_key_id: k })] }));
        await r.pod.tick();
        await r.pod.idle();
        expect(r.asked).toEqual([]);
        const body = r.calls.find((c) => c.path === '/api/v1/pod/pod-1/signature')!.body as { key_id: string; signature: string };
        expect(body.key_id).toBe(keyId);
        const key = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: publicKey }, format: 'jwk' });
        expect(verify(null, hashOf(CLAIM), key, Buffer.from(body.signature, 'base64url'))).toBe(true);
    });

    it('ignores a claim for another host key', async () => {
        const { r } = await asTheHost(() => ({ pending: [item({ host_key_id: 'f'.repeat(32) })] }));
        await r.pod.tick();
        await r.pod.idle();
        expect(r.calls.some((c) => c.path.endsWith('/signature'))).toBe(false);
        expect(r.asked).toEqual([]);
    });

    it('asks the person for an hitl claim, naming the task, the score and the commits, and signs only on Sign', async () => {
        const { r } = await asTheHost((k) => ({ pending: [item({ host_key_id: k, approval: 'hitl' })], approval: 'allowed' }));
        await r.pod.tick();
        await r.pod.idle();
        expect(r.asked).toHaveLength(1);
        expect(r.asked[0]).toContain('7');
        expect(r.asked[0]).toContain('0.800');
        expect(r.asked[0]).toContain('C5');
        expect(r.asked[0]).toContain('aaaaaaa');
        expect(r.calls.some((c) => c.path === '/api/v1/pod/pod-1/signature')).toBe(true);
    });

    it('does not sign when the person declines, and does not ask again on the next poll', async () => {
        const { r } = await asTheHost((k) => ({ pending: [item({ host_key_id: k, approval: 'hitl' })], approval: 'denied' }));
        await r.pod.tick();
        await r.pod.idle();
        await r.pod.tick();
        await r.pod.idle();
        expect(r.calls.some((c) => c.path.endsWith('/signature'))).toBe(false);
        expect(r.asked).toHaveLength(1);
    });

    it('refuses a claim whose hash is not the SHA-256 of its canonical form, whichever way it is approved', async () => {
        const wrong = b64u(createHash('sha256').update('something else').digest());
        const { r } = await asTheHost((k) => ({ pending: [item({ host_key_id: k, claim_hash: wrong }), item({ id: 'pod-2', host_key_id: k, approval: 'hitl', claim_hash: b64u(Buffer.alloc(32)) })] }));
        await r.pod.tick();
        await r.pod.idle();
        expect(r.calls.some((c) => c.path.endsWith('/signature'))).toBe(false);
        expect(r.asked).toEqual([]);
        expect(r.logs.join('\n')).toMatch(/hash/i);
    });

    it('is not blocked by a refusal from Tynn: the next claim is still tried, and no note is written', async () => {
        const { r } = await asTheHost((k) => ({ pending: [item({ host_key_id: k }), item({ id: 'pod-2', host_key_id: k })], signStatus: 422 }));
        await r.pod.tick();
        await r.pod.idle();
        expect(r.calls.filter((c) => c.path.endsWith('/signature'))).toHaveLength(2);
        expect(r.gitCalls).toEqual([]);
    });
});

describe('the git note', () => {
    const noteText = `pod1.HASH.SIG\n${canonicalize(CLAIM)}`;

    it('is written on each attested commit in the workspace that holds it: line 1 the token, then the canonical claim, ref proof-of-done', async () => {
        const { r } = await asTheHost((k) => ({ pending: [item({ host_key_id: k })], gitHas: (cwd, sha) => cwd === '/work/widgets' && sha[0] === 'a' }));
        await r.pod.tick();
        await r.pod.idle();
        const add = r.gitCalls.find((g) => g.args[0] === 'notes')!;
        expect(add.cwd).toBe('/work/widgets');
        expect(add.args).toEqual(['notes', '--ref=proof-of-done', 'add', '-f', '-m', noteText, 'a'.repeat(40)]);
        const lines = String(add.args[5]).split('\n');
        expect(lines[0]).toBe('pod1.HASH.SIG');
        expect(lines[1]).toBe(canonicalize(CLAIM));
        const push = r.gitCalls.find((g) => g.args[0] === 'push')!;
        expect(push.cwd).toBe('/work/widgets');
        expect(push.args).toEqual(['push', 'origin', 'refs/notes/proof-of-done:refs/notes/proof-of-done']);
    });

    it('is remembered and retried when the commit is not here yet, and the signing is not blocked', async () => {
        let present = false;
        const { r } = await asTheHost((k) => ({ pending: [item({ host_key_id: k })], gitHas: () => present }));
        await r.pod.tick();
        await r.pod.idle();
        expect(r.calls.some((c) => c.path.endsWith('/signature'))).toBe(true);
        expect(r.retry().map((n) => n.sha).sort()).toEqual(['a'.repeat(40), 'b'.repeat(40)]);
        present = true;
        await r.pod.tick();
        await r.pod.idle();
        expect(r.gitCalls.filter((g) => g.args[0] === 'notes')).toHaveLength(2);
        expect(r.retry()).toEqual([]);
    });

    it('keeps the push for later when it fails, and does not write the note twice', async () => {
        const { r } = await asTheHost((k) => ({ pending: [item({ host_key_id: k })], gitHas: () => true, pushOk: false }));
        await r.pod.tick();
        await r.pod.idle();
        expect(r.retry().length).toBeGreaterThan(0);
        const notesBefore = r.gitCalls.filter((g) => g.args[0] === 'notes').length;
        r.setPush(true);
        await r.pod.tick();
        await r.pod.idle();
        expect(r.gitCalls.filter((g) => g.args[0] === 'notes')).toHaveLength(notesBefore);
        expect(r.retry()).toEqual([]);
    });

    it('never passes a non-hex commit to git', async () => {
        const claim = { ...CLAIM, work: { repo: 'x', commits: ['--upload-pack=evil', 'c'.repeat(40)] } };
        const { r } = await asTheHost((k) => ({ pending: [item({ host_key_id: k }, claim)], gitHas: () => true }));
        await r.pod.tick();
        await r.pod.idle();
        // The note's MESSAGE is the signed claim verbatim, so it carries the string; no git ARGUMENT other than that message may.
        const argumentsOf = (g: { args: readonly string[] }) => g.args.filter((_, i) => g.args[i - 1] !== '-m');
        expect(r.gitCalls.some((g) => argumentsOf(g).some((a) => String(a).includes('upload-pack')))).toBe(false);
        expect(r.gitCalls.filter((g) => g.args[0] === 'cat-file')).toHaveLength(1);
        expect(r.gitCalls.some((g) => g.args.includes('c'.repeat(40)))).toBe(true);
    });
});
