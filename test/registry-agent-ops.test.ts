import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Registry } from '../src/main/registry.js';
import { Store } from '../src/main/store.js';

/**
 * THE REGISTRY'S AGENT OPERATIONS (§6.2) — forget a record (unmount/delete), clear its thread (a
 * fresh restart), change its provider (switch driver), set its daily budget. Each writes to disk and
 * emits; an unknown agent is `null`/`false`, never a throw; an unknown provider is refused. The
 * budget is an OPTIONAL field: records written before it exist still load.
 */

let dir: string;
let registry: Registry;

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'genie2-registry-ops-'));
    registry = new Registry(new Store(dir));
    await registry.load({ name: 'alphar', healthy: true });
    await registry.addWorkspace({ id: 'tynn', path: '/w/tynn' });
});

afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
});

describe('agent operations', () => {
    it('forget removes the record from memory and disk; a second forget is false', async () => {
        const a = await registry.register({ workspaceId: 'tynn', provider: 'claude', name: 'atlas' });
        expect(await registry.forget(a.id)).toBe(true);
        expect(registry.find(a.id)).toBeNull();
        expect(await registry.forget(a.id)).toBe(false);
        const reopened = new Registry(new Store(dir));
        await reopened.load({ name: 'alphar', healthy: true });
        expect(reopened.find(a.id)).toBeNull();
    });

    it('clearThread drops the conversation (a fresh restart) and answers the updated record', async () => {
        const a = await registry.register({ workspaceId: 'tynn', provider: 'claude', name: 'atlas' });
        await registry.recordThread(a.id, 'sess-1');
        expect(registry.find(a.id)!.threadId).toBe('sess-1');
        const cleared = await registry.clearThread(a.id);
        expect(cleared?.threadId).toBeNull();
        expect(registry.find(a.id)!.threadId).toBeNull();
        expect(await registry.clearThread('agent_nope' as never)).toBeNull();
    });

    it('setProvider changes the driver and keeps the agent; an unknown provider is refused by name', async () => {
        const a = await registry.register({ workspaceId: 'tynn', provider: 'claude', name: 'atlas' });
        const switched = await registry.setProvider(a.id, 'codex', { keepModel: false });
        expect(switched).toMatchObject({ ok: true, record: { id: a.id, provider: 'codex', name: 'atlas', workspaceId: 'tynn' } });
        expect(await registry.setProvider(a.id, 'kimi' as never, { keepModel: false })).toEqual({ ok: false, reason: 'Genie cannot run a "kimi" agent; the providers it knows are claude, codex' });
    });

    it('a NEW provider starts a new conversation: the old provider’s thread never carries over (null = never ran on this provider), on disk too', async () => {
        const a = await registry.register({ workspaceId: 'tynn', provider: 'claude', name: 'atlas' });
        await registry.recordThread(a.id, 'claude-sess-1');
        const switched = await registry.setProvider(a.id, 'codex', { keepModel: false });
        expect(switched.ok && switched.record.threadId).toBeNull();
        const reopened = new Registry(new Store(dir));
        await reopened.load({ name: 'alphar', healthy: true });
        expect(reopened.find(a.id)).toMatchObject({ provider: 'codex', threadId: null });
    });

    it('the model goes with the old provider unless the caller says the new one lists it (keepModel)', async () => {
        const a = await registry.register({ workspaceId: 'tynn', provider: 'claude', name: 'atlas' });
        await registry.setModel(a.id, 'opus');
        const dropped = await registry.setProvider(a.id, 'codex', { keepModel: false });
        expect(dropped.ok && dropped.record.model).toBeUndefined();

        const b = await registry.register({ workspaceId: 'tynn', provider: 'claude', name: 'nova' });
        await registry.setModel(b.id, 'shared-model');
        const kept = await registry.setProvider(b.id, 'codex', { keepModel: true });
        expect(kept.ok && kept.record.model).toBe('shared-model');
    });

    it('setProvider to the SAME provider changes nothing: the thread and model stay', async () => {
        const a = await registry.register({ workspaceId: 'tynn', provider: 'claude', name: 'atlas' });
        await registry.recordThread(a.id, 'sess-1');
        await registry.setModel(a.id, 'opus');
        const same = await registry.setProvider(a.id, 'claude', { keepModel: false });
        expect(same).toMatchObject({ ok: true, record: { provider: 'claude', threadId: 'sess-1', model: 'opus' } });
    });

    it('setBudget stores a daily limit (or clears it) as an OPTIONAL field — older records without it still load', async () => {
        const a = await registry.register({ workspaceId: 'tynn', provider: 'claude', name: 'atlas' });
        expect(registry.find(a.id)!.dailyBudgetUsd).toBeUndefined();
        expect((await registry.setBudget(a.id, 5))?.dailyBudgetUsd).toBe(5);
        expect((await registry.setBudget(a.id, null))?.dailyBudgetUsd).toBeNull();
        const onDisk = JSON.parse(await readFile(join(dir, 'runtime', 'agents.json'), 'utf8')) as Array<Record<string, unknown>>;
        expect(onDisk.find((r) => r.id === a.id)).toMatchObject({ dailyBudgetUsd: null });
        const reopened = new Registry(new Store(dir));
        await reopened.load({ name: 'alphar', healthy: true });
        expect(reopened.find(a.id)).not.toBeNull();
    });
});
