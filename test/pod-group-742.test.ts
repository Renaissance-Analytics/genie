import { createHash } from 'node:crypto';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { EMPTY_TOASTS, toastReducer, toastView } from '../src/core/approval-toasts.js';
import type { DeckItem } from '../src/core/deck.js';
import { canonicalize } from '../src/core/jcs.js';
import { ApprovalQueue } from '../src/main/approval-queue.js';
import { answerDeck, type DeckAnswerPorts } from '../src/main/deck-answer.js';
import type { Caller } from '../src/main/mcp-tools.js';
import { ProofOfDone, podKeyId, type PodPorts } from '../src/main/proof-of-done.js';
import { podApproval } from '../src/main/proof-of-done-host.js';
import { ApprovalToastStack } from '../src/renderer/components/ApprovalToasts.js';

/**
 * ONE ASK FOR EVERY WAITING CLAIM (Tynn #742; the owner, 2026-11-24): after a restart Genie put about 100 separate "Genie
 * wants to sign a Proof-of-Done" cards on the Deck, one per waiting HITL claim, each reading "a workspace not known here"
 * with only a task id and a score. Now every waiting claim is a line of ONE Deck item that names its Tynn project and its
 * task (number and title, read from Tynn), answered with Sign all / Deny all. A claim that arrives joins the item; a claim
 * Tynn stops listing leaves it (#858). Each signature is still its own, through the one signing path.
 */

const genie: Caller = { agentId: 'genie-proof-of-done' as Caller['agentId'], agentName: 'Genie', workspaceId: '', workspacePath: '' };
const flush = async () => { for (let i = 0; i < 20; i += 1) await Promise.resolve(); };

describe('the approval queue groups Proof-of-Done asks', () => {
    it('N claims are ONE Deck item that lists each, with Sign all and Deny all', () => {
        const q = new ApprovalQueue({ now: () => 1_000 });
        void q.gate(genie, 'pod.sign', 'Acme · #12 Group the asks · How Done? 0.100 (C1)');
        void q.gate(genie, 'pod.sign', 'Acme · #13 Name the project · How Done? 0.400 (C2)');
        void q.gate(genie, 'pod.sign', 'Beta · #4 Ship it · How Done? 0.900 (C6)');
        const items = q.deckItems();
        expect(items).toHaveLength(1);
        const [group] = items;
        expect(group!.title).toContain('#12 Group the asks');
        expect(group!.title).toContain('#13 Name the project');
        expect(group!.title).toContain('Beta · #4 Ship it');
        expect(group!.title).toMatch(/3 Proof-of-Done/);
        expect(group!.answer).toEqual({ kind: 'inline', options: [{ id: 'allow', label: 'Sign all', tone: 'ok' }, { id: 'deny', label: 'Deny all', tone: 'bad' }] });
        expect(group).toMatchObject({ source: 'agent-question', agentName: 'Genie', workspaceId: null, blocking: true });
        expect(group!.id.startsWith('appr_')).toBe(true);
    });

    it('CONTROL: other actions are still one item per request', () => {
        const q = new ApprovalQueue({ now: () => 1_000 });
        void q.gate(genie, 'create', 'zsh');
        void q.gate(genie, 'create', 'bash');
        expect(q.deckItems()).toHaveLength(2);
    });

    it('a claim that arrives JOINS the item: same id, one more line, a new revision', () => {
        const q = new ApprovalQueue({ now: () => 1_000 });
        void q.gate(genie, 'pod.sign', 'Acme · #12 Group the asks');
        void q.gate(genie, 'pod.sign', 'Acme · #13 Name the project');
        const before = q.deckItems()[0]!;
        void q.gate(genie, 'pod.sign', 'Acme · #14 Late arrival');
        const after = q.deckItems();
        expect(after).toHaveLength(1);
        expect(after[0]!.id).toBe(before.id);
        expect(after[0]!.title).toContain('#14 Late arrival');
        expect(after[0]!.revision ?? 0).toBeGreaterThan(before.revision ?? 0);
    });

    it('a withdrawn claim LEAVES the item, recorded as cancelled; the rest still wait', async () => {
        const q = new ApprovalQueue({ now: () => 1_000 });
        const gone = new AbortController();
        const a = q.gate(genie, 'pod.sign', 'Acme · #12 Group the asks', { signal: gone.signal });
        void q.gate(genie, 'pod.sign', 'Acme · #13 Name the project');
        gone.abort('Tynn no longer lists this claim as waiting');
        expect(await a).toBe('denied');
        const items = q.deckItems();
        expect(items).toHaveLength(1);
        expect(items[0]!.title).not.toContain('#12');
        expect(items[0]!.title).toContain('#13 Name the project');
        expect(q.lastCancelled()).toEqual([{ action: 'pod.sign', detail: 'Acme · #12 Group the asks', reason: 'Tynn no longer lists this claim as waiting' }]);
    });

    it('Sign all allows EACH claim; Deny all denies each', async () => {
        const q = new ApprovalQueue({ now: () => 1_000 });
        const signs = [q.gate(genie, 'pod.sign', 'A · #1 one'), q.gate(genie, 'pod.sign', 'A · #2 two'), q.gate(genie, 'pod.sign', 'A · #3 three')];
        expect(q.resolve(q.deckItems()[0]!.id, 'allow')).toBe(true);
        expect(await Promise.all(signs)).toEqual(['allowed', 'allowed', 'allowed']);
        expect(q.deckItems()).toEqual([]);

        const denies = [q.gate(genie, 'pod.sign', 'A · #4 four'), q.gate(genie, 'pod.sign', 'A · #5 five')];
        expect(q.resolve(q.deckItems()[0]!.id, 'deny')).toBe(true);
        expect(await Promise.all(denies)).toEqual(['denied', 'denied']);
        expect(q.deckItems()).toEqual([]);
    });

    it('claims nobody answered in time are ONE expired notice, dismissed at once', async () => {
        let clock = 1_000;
        const q = new ApprovalQueue({ now: () => clock, timeoutMs: 100 });
        const asks = [q.gate(genie, 'pod.sign', 'A · #1 one'), q.gate(genie, 'pod.sign', 'A · #2 two')];
        clock += 1_000;
        q.sweep();
        expect(await Promise.all(asks)).toEqual(['expired', 'expired']);
        const notices = q.deckItems();
        expect(notices).toHaveLength(1);
        expect(notices[0]!.id.startsWith('apprx_')).toBe(true);
        expect(q.dismissExpired(notices[0]!.id)).toBe(true);
        expect(q.deckItems()).toEqual([]);
    });

    it('the item names Tynn, never "a workspace not known here", on its toast', () => {
        const q = new ApprovalQueue({ now: () => 1_000 });
        void q.gate(genie, 'pod.sign', 'Acme Widgets · #12 Group the asks · How Done? 0.100 (C1)');
        void q.gate(genie, 'pod.sign', 'Acme Widgets · #13 Name the project · How Done? 0.400 (C2)');
        const items = q.deckItems();
        const view = toastView(toastReducer(EMPTY_TOASTS, { kind: 'items', items, dnd: false }), items);
        const html = renderToStaticMarkup(createElement(ApprovalToastStack, { view, onAnswer: () => {}, onExpand: () => {}, workspaces: [], agents: [] }));
        expect(html).not.toContain('not known here');
        expect(html).toMatch(/data-approval-toast-workspace=""[^>]*>Tynn</);
        expect(html).toContain('Acme Widgets · #12 Group the asks');
        expect(html).toContain('Sign all');
        expect(html).toContain('Deny all');
    });
});

describe('Sign all signs only the list the person read', () => {
    const ports = (items: DeckItem[]) => {
        const resolve = vi.fn((_id: string, _choice: 'allow' | 'deny') => true);
        const p = {
            deckItems: () => items,
            attention: { answer: async () => true as never, pending: () => [], lists: { done: async () => true } },
            approvals: { resolve },
            inbox: { unread: () => [], receive: async () => [] as never },
        } as unknown as DeckAnswerPorts;
        return { p, resolve };
    };

    it('an answer to an older list (a claim joined since) is refused, and nothing is signed', async () => {
        const q = new ApprovalQueue({ now: () => 1_000 });
        void q.gate(genie, 'pod.sign', 'A · #1 one');
        const seen = q.deckItems()[0]!;
        void q.gate(genie, 'pod.sign', 'A · #2 two');
        const { p, resolve } = ports(q.deckItems());
        await expect(answerDeck({ kind: 'deck.answer', item: { id: seen.id, revision: seen.revision }, optionId: 'allow' } as never, p)).rejects.toThrow(/changed since you opened it/);
        expect(resolve).not.toHaveBeenCalled();
        // CONTROL: the list as it is now is answered.
        const now = q.deckItems()[0]!;
        await answerDeck({ kind: 'deck.answer', item: { id: now.id, revision: now.revision }, optionId: 'allow' } as never, p);
        expect(resolve).toHaveBeenCalledWith(now.id, 'allow');
    });
});

describe('Proof-of-Done names the Tynn project and the task', () => {
    const CLAIM = (task: string) => ({ v: 'pod/1', request: { system: 'tynn', project: 'p1', task, story: 's1' }, work: { repo: 'acme/widgets', commits: ['a'.repeat(40)] }, score: { value: '0.100', checkpoint: 'C1' }, nonce: `n${task}` });
    const hash = (claim: unknown) => createHash('sha256').update(canonicalize(claim), 'utf8').digest().toString('base64url');
    const TASKS: Record<string, { number: number; title: string }> = { t7: { number: 12, title: 'Group the asks' }, t8: { number: 13, title: 'Name the project' }, t9: { number: 14, title: 'Late arrival' } };

    function host(options: { taskStatus?: number; signStatus?: () => number } = {}) {
        const queue = new ApprovalQueue({ now: () => 1_000 });
        const secrets = new Map<string, string>();
        let pending: unknown[] = [];
        const signed: string[] = [];
        const lookups: string[] = [];
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
                    if (path === '/api/v1/pod/pending') return { ok: true, status: 200, json: async () => ({ data: pending }) };
                    const task = /^\/api\/v1\/projects\/p1\/tasks\/([^/]+)$/.exec(path);
                    if (task && init.method === 'GET') {
                        lookups.push(task[1]!);
                        const status = options.taskStatus ?? 200;
                        const t = TASKS[task[1]!]!;
                        return { ok: status < 300, status, json: async () => ({ kind: 'task', id: task[1], number: t.number, title: t.title, project: { id: 'p1', name: 'Acme Widgets' } }) };
                    }
                    const status = options.signStatus?.() ?? 200;
                    if (status < 300) signed.push(path);
                    return { ok: status < 300, status, json: async () => ({ data: { token: 't' } }) };
                },
            },
            approve: podApproval(queue, genie),
            workspaces: () => [],
            git: async () => ({ ok: false, stdout: '' }),
            retry: { load: async () => [], save: async () => {} },
            label: () => 'Desk',
            log: () => {},
        };
        const pod = new ProofOfDone(ports);
        const claim = (id: string, task: string) => ({ id, approval: 'hitl', host_key_id: keyId, claim: CLAIM(task), claim_hash: hash(CLAIM(task)) });
        return { queue, pod, signed, lookups, claim, setPending: (p: unknown[]) => { pending = p; } };
    }

    it('each line is the project and the task number and title, with its score', async () => {
        const h = host();
        await h.pod.tick();
        h.setPending([h.claim('pod-1', 't7'), h.claim('pod-2', 't8')]);
        await h.pod.tick();
        await flush();
        const items = h.queue.deckItems();
        expect(items).toHaveLength(1);
        expect(items[0]!.title).toContain('Acme Widgets · #12 Group the asks');
        expect(items[0]!.title).toContain('Acme Widgets · #13 Name the project');
        expect(items[0]!.title).toContain('How Done? 0.100');
    });

    it('a task Tynn would not describe still names the repository, never a bare id alone', async () => {
        const h = host({ taskStatus: 404 });
        await h.pod.tick();
        h.setPending([h.claim('pod-1', 't7')]);
        await h.pod.tick();
        await flush();
        const title = h.queue.deckItems()[0]!.title;
        expect(title).toContain('acme/widgets');
        expect(title).toContain('How Done? 0.100');
    });

    it('a claim that arrives joins the one item; one Tynn no longer lists leaves it; Sign all signs each through its own signature', async () => {
        const h = host();
        await h.pod.tick();
        h.setPending([h.claim('pod-1', 't7'), h.claim('pod-2', 't8')]);
        await h.pod.tick();
        await flush();
        h.setPending([h.claim('pod-2', 't8'), h.claim('pod-3', 't9')]);
        await h.pod.tick();
        await flush();
        const items = h.queue.deckItems();
        expect(items).toHaveLength(1);
        expect(items[0]!.title).not.toContain('#12 Group the asks');
        expect(items[0]!.title).toContain('#13 Name the project');
        expect(items[0]!.title).toContain('#14 Late arrival');
        expect(h.signed).toEqual([]);

        h.queue.resolve(items[0]!.id, 'allow');
        await h.pod.idle();
        expect([...h.signed].sort()).toEqual(['/api/v1/pod/pod-2/signature', '/api/v1/pod/pod-3/signature']);
    });

    it('a signature Tynn turned away for now (429) is sent again at the next poll WITHOUT asking again', async () => {
        let first = true;
        const h = host({ signStatus: () => { if (first) { first = false; return 429; } return 200; } });
        await h.pod.tick();
        h.setPending([h.claim('pod-1', 't7')]);
        await h.pod.tick();
        await flush();
        h.queue.resolve(h.queue.deckItems()[0]!.id, 'allow');
        await h.pod.idle();
        expect(h.signed).toEqual([]);
        await h.pod.tick();
        await flush();
        expect(h.queue.deckItems()).toEqual([]);
        await h.pod.idle();
        expect(h.signed).toEqual(['/api/v1/pod/pod-1/signature']);
    });
});
