import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentId } from '../src/core/identity.js';
import { OS_AGENT_NAME, OS_WORKSPACE, Registry } from '../src/main/registry.js';
import { Store } from '../src/main/store.js';

/**
 * THE RAIL'S `genie` ROW REACHES THE OS AGENT. The rail links to `genie://agent/genie` — by NAME,
 * because the OS agent's id is minted on first boot and the rail cannot know it. The registry's
 * lookup resolved ids only, so the row landed on "No agent is registered as genie" (the owner's
 * first run of 2.0.0-beta.5). The name of the one agent that has no workspace is an alias for it.
 */
describe('Registry.find', () => {
    let dir: string;
    let registry: Registry;
    beforeEach(async () => {
        dir = await mkdtemp(join(tmpdir(), 'genie2-os-alias-'));
        registry = new Registry(new Store(dir));
        await registry.load({ name: 'alphar', healthy: true });
    });
    afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

    it("resolves the OS agent's NAME to its record, the same record its id resolves to", () => {
        const byName = registry.find(OS_AGENT_NAME as AgentId);
        expect(byName).not.toBeNull();
        expect(byName!.workspaceId).toBe(OS_WORKSPACE);
        expect(byName!.name).toBe(OS_AGENT_NAME);
        expect(registry.find(byName!.id)).toBe(byName);
    });

    it('CONTROL: an unknown id is still null, and a workspace agent named genie is NOT the OS agent', async () => {
        expect(registry.find('agent_doesnotexist' as AgentId)).toBeNull();
        await registry.addWorkspace({ id: 'tynn', path: dir });
        const impostor = await registry.register({ workspaceId: 'tynn', provider: 'claude', name: OS_AGENT_NAME });
        expect(registry.find(OS_AGENT_NAME as AgentId)!.workspaceId).toBe(OS_WORKSPACE);
        expect(registry.find(impostor.id)!.workspaceId).toBe('tynn');
    });

    it('register keeps the persona it is given, so an imported agent reads its AGENT.md', async () => {
        await registry.addWorkspace({ id: 'tynn', path: dir });
        const a = await registry.register({ workspaceId: 'tynn', provider: 'codex', name: 'kai', instructions: '.agents/kai/AGENT.md' });
        expect(a.instructions).toBe('.agents/kai/AGENT.md');
        expect(registry.find(a.id)!.instructions).toBe('.agents/kai/AGENT.md');
    });
});
