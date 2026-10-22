import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentId } from '../src/core/identity.js';
import { Registry } from '../src/main/registry.js';
import { Store } from '../src/main/store.js';

/**
 * AN AGENT'S SETTINGS ARE LIVE (the owner, 2026-10-14: "I was not able to change your model … it was
 * stuck on default. All settings UI for agents is not live"). The Agent view reads the model, the
 * tool setting, the mode, the scope and the budget from the agent's DETAIL, and the detail is pushed
 * on a per-agent channel. Saving a setting changed the RECORD and emitted the estate snapshot only —
 * nothing pushed the agent's detail, so the controlled picker snapped back to the old value while the
 * new one sat on disk. The registry now names the agent whose record changed, and both the window and
 * a remote connection push that agent's detail from it.
 */

let dir: string;
let registry: Registry;

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'genie2-settings-live-'));
    registry = new Registry(new Store(dir));
    await registry.load({ name: 'alphar', healthy: true });
    await registry.addWorkspace({ id: 'tynn', path: '/w/tynn' });
});

afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
});

describe('the registry names the agent whose record changed', () => {
    it('once per saved setting — model, tool setting, mode, scope, budget, provider, fresh restart — and never for an unknown agent', async () => {
        const a = await registry.register({ workspaceId: 'tynn', provider: 'claude', name: 'atlas' });
        const heard: AgentId[] = [];
        const off = registry.subscribeAgentRecords((id) => heard.push(id));

        await registry.setModel(a.id, 'opus');
        await registry.setPermissions(a.id, 'ask');
        await registry.setMode(a.id, 'automated');
        await registry.setAccessScope(a.id, 'all');
        await registry.setBudget(a.id, 5);
        await registry.setProvider(a.id, 'codex', { keepModel: false });
        await registry.clearThread(a.id);
        // COUNTED: seven saves, seven announcements, each naming this agent.
        expect(heard).toEqual(Array(7).fill(a.id));

        // The record the listener would read is already the new one when it hears.
        const seen: Array<string | null> = [];
        const off2 = registry.subscribeAgentRecords((id) => seen.push(registry.find(id)?.model ?? null));
        await registry.setModel(a.id, 'haiku');
        expect(seen).toEqual(['haiku']);
        off2();

        await registry.setModel('agent_nobody' as AgentId, 'opus');
        expect(heard).toHaveLength(8);
        off();
        await registry.setModel(a.id, null);
        expect(heard).toHaveLength(8);
    });
});

describe('main pushes the agent detail when its record changes', () => {
    // Comments stripped first, so a sentence about the wiring cannot stand in for the wiring.
    const main = readFileSync(new URL('../src/main/main.ts', import.meta.url), 'utf8')
        .split(/\r?\n/)
        .map((line) => line.replace(/\/\/.*$/, ''))
        .join('\n');

    it('the window: the registry\'s record changes feed pushAgent, the same push a session event makes', () => {
        expect(main.match(/registry\.subscribeAgentRecords\(\s*pushAgent\s*\)/g) ?? []).toHaveLength(1);
    });

    it('a remote connection: the host api is given the registry\'s record changes', () => {
        expect(main.match(/subscribeAgentRecords:\s*\(cb\)\s*=>\s*registry!\.subscribeAgentRecords\(cb\)/g) ?? []).toHaveLength(1);
    });
});
