import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { agentRecord, mintAgentId, type AgentId, type AgentRecord } from '../src/core/identity.js';
import { Registry } from '../src/main/registry.js';
import { Store } from '../src/main/store.js';
import { switchDriver, type AgentOpsPorts } from '../src/main/agent-ops-host.js';

/*
 * Accounts S2 (Tynn #475), corrected by R1 (Tynn #751): an agent has NO account of its own. The provider's one active account
 * is the host's, so each native thread belongs to one provider; a thread is parked by provider when the agent changes
 * provider, and stays the agent's across an account switch. Records stored in the S2 shape load without their account and
 * with their threads folded back to the provider. Fixtures use no real person.
 */
const A = `account_${'a'.repeat(32)}`;
type Stored = AgentRecord & { accountId?: string; threadIds?: Readonly<Record<string, string>>; leftAt?: Readonly<Record<string, string>> };
let dir: string;
let id: AgentId;
let record: AgentRecord;
beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'genie-accounts-475-'));
    id = mintAgentId();
    record = { ...agentRecord({ id, workspaceId: 'work', provider: 'claude', name: 'fixture' }), threadId: 'thread-A' };
    await mkdir(join(dir, 'runtime'));
    await writeFile(join(dir, 'runtime', 'workspaces.json'), JSON.stringify([{ id: 'work', path: dir }]));
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

async function load(seed: Stored | Record<string, unknown> = record): Promise<Registry> {
    await writeFile(join(dir, 'runtime', 'agents.json'), JSON.stringify([seed]));
    const registry = new Registry(new Store(dir));
    await registry.load({ name: 'fixture', healthy: true });
    return registry;
}
const read = (registry: Registry): Stored | null => registry.find(id) as Stored | null;

describe('an agent carries no account', () => {
    it('a new agent record has no accountId', () => {
        expect('accountId' in agentRecord({ id, workspaceId: 'work', provider: 'claude', name: 'fixture' })).toBe(false);
        expect('accountId' in agentRecord({ id, workspaceId: 'work', provider: 'codex', name: 'fixture' })).toBe(false);
    });

    it('loads an agent stored with an account without it, keeping its current thread, identity and settings, and the disk follows', async () => {
        const registry = await load({ ...record, accountId: A, model: 'sonnet', permissions: 'ask' });
        expect(read(registry)).toMatchObject({ threadId: 'thread-A', model: 'sonnet', permissions: 'ask', id, name: 'fixture' });
        expect('accountId' in read(registry)!).toBe(false);
        const disk = JSON.parse(await readFile(join(dir, 'runtime', 'agents.json'), 'utf8')) as Stored[];
        expect('accountId' in disk.find(a => a.id === id)!).toBe(false);
    });

    it('folds S2 account-namespaced parked threads and departure times back to the provider; a legacy slot wins over a managed one', async () => {
        const registry = await load({ ...record, accountId: A,
            threadIds: { 'codex:account_legacy_codex': 'legacy-codex', [`codex:account_${'c'.repeat(32)}`]: 'managed-codex' },
            leftAt: { 'codex:account_legacy_codex': '2026-11-14T00:00:00Z' } });
        expect(read(registry)?.threadIds).toEqual({ codex: 'legacy-codex' });
        expect(read(registry)?.leftAt).toEqual({ codex: '2026-11-14T00:00:00Z' });
    });

    it('older provider-keyed parked threads are already the shape and stay', async () => {
        const registry = await load({ ...record, threadIds: { codex: 'old-codex' }, leftAt: { codex: '2026-11-14T00:00:00Z' } });
        expect(read(registry)?.threadIds).toEqual({ codex: 'old-codex' });
        expect(read(registry)?.leftAt).toEqual({ codex: '2026-11-14T00:00:00Z' });
    });

    it('a malformed parked-thread namespace is reported instead of silently kept', async () => {
        const registry = await load({ ...record, threadIds: { 'claude:../../bad': 'x' } });
        expect(read(registry)).toBeNull();
        expect(registry.faults.join(' ')).toMatch(/thread|provider/i);
    });
});

describe('a provider change parks the thread by provider', () => {
    it('claude to codex parks the claude thread under the provider and starts codex with none', async () => {
        const registry = await load();
        const answer = await registry.setProvider(id, 'codex', { keepModel: false, now: '2026-11-16T00:00:00.000Z' });
        expect(answer.ok && 'accountId' in answer.record).toBe(false);
        expect(read(registry)).toMatchObject({ provider: 'codex', threadId: null, threadIds: { claude: 'thread-A' }, leftAt: { claude: '2026-11-16T00:00:00.000Z' } });
    });

    it('and back again resumes the parked thread, also after a registry restart', async () => {
        const registry = await load();
        await registry.setProvider(id, 'codex', { keepModel: false });
        await registry.recordThread(id, 'thread-codex');
        await registry.setProvider(id, 'claude', { keepModel: false });
        expect(read(registry)).toMatchObject({ provider: 'claude', threadId: 'thread-A', threadIds: { codex: 'thread-codex' } });
        const again = new Registry(new Store(dir));
        await again.load({ name: 'fixture', healthy: true });
        await again.setProvider(id, 'codex', { keepModel: false });
        expect(again.find(id)).toMatchObject({ provider: 'codex', threadId: 'thread-codex' });
    });

    it('provider-switch carry-over uses the destination provider departure time', async () => {
        const since = Date.parse('2026-11-15T00:00:00.000Z');
        const registry = await load({ ...record, leftAt: { codex: new Date(since).toISOString() } });
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
        const carry = read(registry)?.carryOver?.text;
        expect(carry).toContain('new work since leaving');
        expect(carry).not.toContain('already in the destination thread');
    });

    it('CONTROL: selecting the same provider changes nothing', async () => {
        const registry = await load();
        const before = read(registry);
        expect((await registry.setProvider(id, 'claude', { keepModel: true })).ok).toBe(true);
        expect(read(registry)).toEqual(before);
    });

    it('CONTROL: a model edit keeps the current native thread', async () => {
        const registry = await load();
        await registry.setModel(id, 'sonnet');
        expect(read(registry)).toMatchObject({ threadId: 'thread-A', model: 'sonnet' });
    });

    it('CONTROL: a genuinely unknown provider is still refused', async () => {
        const registry = await load();
        expect(await registry.setProvider(id, 'other', { keepModel: false })).toMatchObject({ ok: false });
        expect(read(registry)).toMatchObject({ provider: 'claude', threadId: 'thread-A' });
    });
});
