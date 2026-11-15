import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { agentRecord, mintAgentId, type AgentId, type AgentRecord } from '../src/core/identity.js';
import { Registry } from '../src/main/registry.js';
import { Store } from '../src/main/store.js';
import { switchDriver, type AgentOpsPorts } from '../src/main/agent-ops-host.js';

const A = `account_${'a'.repeat(32)}`;
const B = `account_${'b'.repeat(32)}`;
const C = `account_${'c'.repeat(32)}`;
const LEGACY = 'account_legacy_claude';
const key = (provider: string, account: string) => `${provider}:${account}`;
type Bound = AgentRecord & { accountId?: string; threadIds?: Readonly<Record<string, string>>; leftAt?: Readonly<Record<string, string>> };
type AccountLookup = { accountById(id: string): { id: string; provider: 'claude' | 'codex' } | null };
const lookup: AccountLookup = { accountById: id => id === A || id === B ? { id, provider: 'claude' } : id === C ? { id, provider: 'codex' } : null };
const Constructor = Registry as unknown as new (store: Store, accounts?: AccountLookup) => Registry;
let dir: string;
let id: AgentId;
let record: Bound;
beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'genie-accounts-475-'));
    id = mintAgentId();
    record = { ...agentRecord({ id, workspaceId: 'work', provider: 'claude', name: 'fixture' }), accountId: A, threadId: 'thread-A' };
    await mkdir(join(dir, 'runtime'));
    await writeFile(join(dir, 'runtime', 'workspaces.json'), JSON.stringify([{ id: 'work', path: dir }]));
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

async function load(seed: Bound | Record<string, unknown> = record, accounts: AccountLookup | undefined = lookup): Promise<Registry> {
    await writeFile(join(dir, 'runtime', 'agents.json'), JSON.stringify([seed]));
    const registry = new Constructor(new Store(dir), accounts);
    await registry.load({ name: 'fixture', healthy: true });
    return registry;
}
const bound = (registry: Registry): Bound | null => registry.find(id) as Bound | null;
const choose = (registry: Registry, accountId: string, provider: 'claude' | 'codex' = 'claude', now = '2026-11-15T00:00:00.000Z') => {
    const options = { keepModel: true, accountId, now };
    return registry.setProvider(id, provider, options);
};

describe('Accounts S2: each native thread belongs to one provider and account', () => {
    it('new agent records explicitly bind to their provider legacy account', () => {
        const created = agentRecord({ id, workspaceId: 'work', provider: 'claude', name: 'fixture' }) as Bound;
        expect(created.accountId).toBe(LEGACY);
        expect((agentRecord({ id, workspaceId: 'work', provider: 'codex', name: 'fixture' }) as Bound).accountId).toBe('account_legacy_codex');
    });

    it('loads older agents onto legacy without losing their current thread, identity or settings', async () => {
        const { accountId: _old, ...old } = { ...record, model: 'sonnet', permissions: 'ask' as const };
        const registry = await load(old);
        expect(bound(registry)).toMatchObject({ accountId: LEGACY, threadId: 'thread-A', model: 'sonnet', permissions: 'ask', id, name: 'fixture' });
        const disk = JSON.parse(await readFile(join(dir, 'runtime', 'agents.json'), 'utf8')) as Bound[];
        expect(disk.find(a => a.id === id)?.accountId).toBe(LEGACY);
    });

    it('migrates provider-only parked threads and timestamps into only their legacy namespaces', async () => {
        const { accountId: _old, ...old } = record;
        const registry = await load({ ...old, threadIds: { codex: 'old-codex' }, leftAt: { codex: '2026-11-14T00:00:00Z' } });
        expect(bound(registry)?.threadIds).toEqual({ [key('codex', 'account_legacy_codex')]: 'old-codex' });
        expect(bound(registry)?.leftAt).toEqual({ [key('codex', 'account_legacy_codex')]: '2026-11-14T00:00:00Z' });
    });

    it('an already-bound managed account never adopts a provider-only parked thread as its own', async () => {
        const registry = await load({ ...record, threadIds: { claude: 'old-legacy-claude' } });
        expect(bound(registry)?.threadIds).toEqual({ [key('claude', LEGACY)]: 'old-legacy-claude' });
        const answer = await choose(registry, B);
        expect(answer.ok && (answer.record as Bound).accountId).toBe(B);
        expect(bound(registry)?.threadId).toBeNull();
    });

    it('a same-provider account change parks A and starts B with no native thread', async () => {
        const registry = await load();
        const answer = await choose(registry, B);
        expect(answer.ok && (answer.record as Bound).accountId).toBe(B);
        expect(bound(registry)?.threadId).toBeNull();
        expect(bound(registry)?.threadIds).toEqual({ [key('claude', A)]: 'thread-A' });
    });

    it('A to B to A resumes only the matching account thread, also after a registry restart', async () => {
        const registry = await load();
        await choose(registry, B);
        expect(bound(registry)?.accountId).toBe(B);
        await registry.recordThread(id, 'thread-B');
        await choose(registry, A);
        expect(bound(registry)).toMatchObject({ accountId: A, threadId: 'thread-A', threadIds: { [key('claude', B)]: 'thread-B' } });
        const again = new Constructor(new Store(dir), lookup);
        await again.load({ name: 'fixture', healthy: true });
        await choose(again, B);
        expect(bound(again)).toMatchObject({ accountId: B, threadId: 'thread-B' });
    });

    it('a fresh target never resumes a thread parked for a different account of that provider', async () => {
        const registry = await load({ ...record, threadIds: { [key('claude', A)]: 'parked-A' } });
        await choose(registry, B);
        expect(bound(registry)?.accountId).toBe(B);
        expect(bound(registry)?.threadId).toBeNull();
    });

    it('records each account departure separately rather than replacing the provider timestamp', async () => {
        const registry = await load();
        await choose(registry, B, 'claude', '2026-11-15T01:00:00.000Z');
        await registry.recordThread(id, 'thread-B');
        await choose(registry, A, 'claude', '2026-11-15T02:00:00.000Z');
        expect(bound(registry)?.leftAt).toEqual({ [key('claude', A)]: '2026-11-15T01:00:00.000Z', [key('claude', B)]: '2026-11-15T02:00:00.000Z' });
    });

    it('replaces carry-over on a same-provider account change while preserving an explicitly kept model', async () => {
        const registry = await load({ ...record, model: 'sonnet', carryOver: { from: 'codex', turns: 1, of: 1, plan: false, text: 'old' } });
        const carryOver = { from: 'claude', turns: 2, of: 2, plan: false, text: 'new conversation' } as const;
        const options = { keepModel: true, accountId: B, carryOver };
        await registry.setProvider(id, 'claude', options);
        expect(bound(registry)).toMatchObject({ accountId: B, model: 'sonnet', carryOver });
    });

    it('refuses an unknown explicit account without changing the agent', async () => {
        const registry = await load();
        const before = bound(registry);
        const answer = await choose(registry, `account_${'d'.repeat(32)}`);
        expect(answer).toMatchObject({ ok: false, reason: expect.stringMatching(/account/i) });
        expect(bound(registry)).toEqual(before);
    });

    it('refuses an explicit account belonging to the other provider', async () => {
        const registry = await load();
        expect(await choose(registry, C)).toMatchObject({ ok: false, reason: expect.stringMatching(/provider|account/i) });
        expect(bound(registry)?.accountId).toBe(A);
    });

    it('absent trusted account lookup refuses a managed-account assignment', async () => {
        await writeFile(join(dir, 'runtime', 'agents.json'), JSON.stringify([record]));
        const registry = new Registry(new Store(dir));
        await registry.load({ name: 'fixture', healthy: true });
        expect(await choose(registry, B)).toMatchObject({ ok: false, reason: expect.stringMatching(/account/i) });
    });

    it('an ordinary provider change still selects that provider legacy account', async () => {
        const registry = await load();
        const answer = await registry.setProvider(id, 'codex', { keepModel: false });
        expect(answer.ok && (answer.record as Bound).accountId).toBe('account_legacy_codex');
        expect(bound(registry)).toMatchObject({ provider: 'codex', threadId: null });
        expect(bound(registry)?.threadIds).toEqual({ [key('claude', A)]: 'thread-A' });
    });

    it('malformed stored account ids are reported instead of silently assigning a different account', async () => {
        const registry = await load({ ...record, accountId: '../../bad' });
        expect(bound(registry)).toBeNull();
        expect(registry.faults.join(' ')).toMatch(/account/i);
    });

    it('provider-switch carry-over uses the destination legacy account departure, not another account timestamp', async () => {
        const since = Date.parse('2026-11-15T00:00:00.000Z');
        const registry = await load({ ...record, leftAt: { [key('codex', 'account_legacy_codex')]: new Date(since).toISOString() } });
        const ports = {
            registry: { find: (agent: AgentId) => registry.find(agent), setProvider: (agent: AgentId, provider: string, options: { keepModel: boolean }) => registry.setProvider(agent, provider, options) },
            providerInstalled: () => true, signedIn: () => true,
            host: { stop: () => true, ended: async () => null },
            history: async () => [
                { at: since - 1, event: { kind: 'message', speaker: 'you', peerName: null, text: 'already in the destination thread' } },
                { at: since + 1, event: { kind: 'message', speaker: 'you', peerName: null, text: 'new work since leaving' } },
            ],
        } as unknown as AgentOpsPorts;
        expect((await switchDriver(ports, id, 'codex')).ok).toBe(true);
        const carry = bound(registry)?.carryOver?.text;
        expect(carry).toContain('new work since leaving');
        expect(carry).not.toContain('already in the destination thread');
    });

    it('CONTROL: selecting the same provider and account changes nothing', async () => {
        const registry = await load();
        const before = bound(registry);
        expect((await choose(registry, A)).ok).toBe(true);
        expect(bound(registry)).toEqual(before);
    });

    it('CONTROL: a model edit keeps the current native thread and the account binding', async () => {
        const registry = await load();
        await registry.setModel(id, 'sonnet');
        expect(bound(registry)).toMatchObject({ accountId: A, threadId: 'thread-A', model: 'sonnet' });
    });

    it('CONTROL: a genuinely unknown provider is still refused', async () => {
        const registry = await load();
        expect(await registry.setProvider(id, 'other', { keepModel: false })).toMatchObject({ ok: false });
        expect(bound(registry)).toMatchObject({ provider: 'claude', accountId: A, threadId: 'thread-A' });
    });
});
