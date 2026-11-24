import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { canonicalize } from '../src/core/jcs.js';
import { ApprovalQueue } from '../src/main/approval-queue.js';
import type { Caller } from '../src/main/mcp-tools.js';
import { ProofOfDone, podKeyId, type PodPorts } from '../src/main/proof-of-done.js';
import { podApproval } from '../src/main/proof-of-done-host.js';

/**
 * THE DECK CARD ITSELF (Tynn #858): genie-host parks a hitl Proof-of-Done claim on the Deck through `podApproval` and the
 * real approval queue. When Tynn stops listing the claim, the card leaves the Deck at the next successful poll, is recorded
 * as cancelled (never as the person's answer) and is never signed. A claim still listed keeps its card, and a failed poll
 * takes none away.
 */

const CLAIM = (task: number) => ({ v: 'pod/1', request: { system: 'tynn', project: 'p1', task, story: 742 }, work: { repo: 'acme/w', commits: ['a'.repeat(40)] }, score: { value: '0.800', checkpoint: 'C5' }, nonce: `n${task}` });
const hash = (claim: unknown) => createHash('sha256').update(canonicalize(claim), 'utf8').digest().toString('base64url');
const caller: Caller = { agentId: 'genie-proof-of-done' as Caller['agentId'], agentName: 'Genie', workspaceId: '', workspacePath: '' };
const flush = async () => { for (let i = 0; i < 10; i += 1) await Promise.resolve(); };

function host() {
    const queue = new ApprovalQueue({ now: () => 1_000 });
    const secrets = new Map<string, string>();
    let pending: unknown[] = [];
    let status = 200;
    const signed: string[] = [];
    let keyId = '';
    const ports: PodPorts = {
        keychain: { get: async (n) => (secrets.has(n) ? { kind: 'value', value: secrets.get(n)! } : { kind: 'missing' }), set: async (n, v) => { secrets.set(n, v); return { ok: true }; } },
        tynn: {
            signedIn: () => true,
            userId: () => 'u1',
            request: async (path, init) => {
                if (path === '/api/v1/pod/host-keys') {
                    keyId = podKeyId(Buffer.from((init.body as { public_key: string }).public_key, 'base64url'));
                    return { ok: true, status: 201, json: async () => ({}) };
                }
                if (path === '/api/v1/pod/pending') return { ok: status < 300, status, json: async () => ({ data: pending }) };
                // The task's words (Tynn #742): not described here, so the ask names the repository and the task.
                if (path.startsWith('/api/v1/projects/')) return { ok: false, status: 404, json: async () => null };
                signed.push(path);
                return { ok: true, status: 200, json: async () => ({ data: { token: 't' } }) };
            },
        },
        approve: podApproval(queue, caller),
        workspaces: () => [],
        git: async () => ({ ok: false, stdout: '' }),
        retry: { load: async () => [], save: async () => {} },
        label: () => 'Desk',
        log: () => {},
    };
    const pod = new ProofOfDone(ports);
    const claim = (id: string, task: number) => ({ id, approval: 'hitl', host_key_id: keyId, claim: CLAIM(task), claim_hash: hash(CLAIM(task)) });
    return { queue, pod, signed, claim, setPending: (p: unknown[]) => { pending = p; }, setStatus: (s: number) => { status = s; } };
}

describe('a superseded claim leaves the Deck (Tynn #858)', () => {
    it('its card goes at the next successful poll, recorded as cancelled, never signed; a claim still listed keeps its card', async () => {
        const h = host();
        await h.pod.tick(); // registers the key
        h.setPending([h.claim('pod-1', 7), h.claim('pod-2', 8)]);
        await h.pod.tick();
        await flush();
        // Both claims are lines of ONE ask (Tynn #742).
        expect(h.queue.deckItems()).toHaveLength(1);
        expect(h.queue.deckItems()[0]!.title).toContain('task 7');
        expect(h.queue.deckItems()[0]!.title).toContain('task 8');

        h.setPending([h.claim('pod-2', 8)]);
        await h.pod.tick();
        await flush();
        const left = h.queue.deckItems();
        expect(left).toHaveLength(1);
        expect(left[0]!.title).toContain('task 8');
        expect(left[0]!.title).not.toContain('task 7');
        expect(h.queue.lastCancelled()).toEqual([{ action: 'pod.sign', detail: expect.stringContaining('task 7'), reason: 'Tynn no longer lists this claim as waiting' }]);
        expect(h.signed).toEqual([]);

        // CONTROL: the card that stayed is still the person's to answer, and Sign still signs it.
        h.queue.resolve(left[0]!.id, 'allow');
        await h.pod.idle();
        expect(h.signed).toEqual(['/api/v1/pod/pod-2/signature']);
    });

    it('a failed poll takes no card away', async () => {
        const h = host();
        await h.pod.tick();
        h.setPending([h.claim('pod-1', 7)]);
        await h.pod.tick();
        await flush();
        expect(h.queue.deckItems()).toHaveLength(1);
        h.setPending([]);
        h.setStatus(502);
        await h.pod.tick();
        await flush();
        expect(h.queue.deckItems()).toHaveLength(1);
        expect(h.queue.lastCancelled()).toEqual([]);
    });
});
