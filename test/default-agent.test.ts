import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { issueWatchPrefsFor } from '../src/core/issue-watch.js';
import { v1DefaultAgents } from '../src/core/v1-import.js';
import { Registry } from '../src/main/registry.js';
import { Store } from '../src/main/store.js';

/**
 * A WORKSPACE'S DEFAULT AGENT — GENIE 1'S (the owner, 2026-10-19: "get rid of the whole sidecar concept. Workspace
 * default agents (which used to be a setting in genie 1)…"; approved FTQ q_09d1f4a0).
 *
 * Genie 1 (`v1:main/db.ts` workspaceDefaultAgent / setWorkspaceDefaultAgent): ONE of a workspace's own agents is
 * designated its default — the agent an action uses when it names none — picked in the workspace's settings. A property
 * OF a real agent, never a placeholder; none designated is a normal state; an agent from another workspace is refused.
 */

let dir: string;
let registry: Registry;

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'genie2-default-agent-'));
    registry = new Registry(new Store(dir));
    await registry.load({ name: 'alphar', healthy: true });
    await registry.addWorkspace({ id: 'tynn', path: '/w/tynn' });
    await registry.addWorkspace({ id: 'fancy', path: '/w/fancy' });
});

afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
});

describe('the registry’s default agent', () => {
    it('none designated is the normal state; designating one of the workspace’s agents sticks, across a restart', async () => {
        const atlas = await registry.register({ workspaceId: 'tynn', provider: 'claude', name: 'atlas' });
        expect(registry.defaultAgentOf('tynn')).toBeNull();

        expect(await registry.setDefaultAgent('tynn', atlas.id)).toEqual({ ok: true });
        expect(registry.defaultAgentOf('tynn')).toBe(atlas.id);
        expect(registry.workspace('tynn')?.defaultAgentId).toBe(atlas.id);

        const reopened = new Registry(new Store(dir));
        await reopened.load({ name: 'alphar', healthy: true });
        expect(reopened.defaultAgentOf('tynn')).toBe(atlas.id);
    });

    it('an agent of ANOTHER workspace is refused in words, and the designation is untouched', async () => {
        const atlas = await registry.register({ workspaceId: 'tynn', provider: 'claude', name: 'atlas' });
        const kai = await registry.register({ workspaceId: 'fancy', provider: 'claude', name: 'kai' });
        await registry.setDefaultAgent('tynn', atlas.id);
        expect(await registry.setDefaultAgent('tynn', kai.id)).toEqual({ ok: false, reason: 'kai is an agent of fancy, not of tynn' });
        expect(registry.defaultAgentOf('tynn')).toBe(atlas.id);
        expect(await registry.setDefaultAgent('moic', atlas.id)).toEqual({ ok: false, reason: 'no workspace moic' });
    });

    it('null clears it; forgetting the default agent clears it too — never a designation pointing at nothing', async () => {
        const atlas = await registry.register({ workspaceId: 'tynn', provider: 'claude', name: 'atlas' });
        await registry.setDefaultAgent('tynn', atlas.id);
        expect(await registry.setDefaultAgent('tynn', null)).toEqual({ ok: true });
        expect(registry.defaultAgentOf('tynn')).toBeNull();

        await registry.setDefaultAgent('tynn', atlas.id);
        await registry.forget(atlas.id);
        expect(registry.defaultAgentOf('tynn')).toBeNull();
    });
});

describe('IssueWatch hears through the default agent', () => {
    const a = (id: string, createdAt: string) => ({ id, workspaceId: 'tynn', createdAt });
    const all = [a('first', '2026-01-01'), a('second', '2026-02-01')];

    it('the DESIGNATED default hears by default; the first agent does not when another is designated', () => {
        expect(issueWatchPrefsFor(all[1]!, all, 'second').delivery).toBe('push');
        expect(issueWatchPrefsFor(all[0]!, all, 'second').delivery).toBe('off');
    });

    it('CONTROL: none designated — the workspace’s first agent, as before', () => {
        expect(issueWatchPrefsFor(all[0]!, all, null).delivery).toBe('push');
        expect(issueWatchPrefsFor(all[1]!, all, null).delivery).toBe('off');
    });
});

describe('Genie 1’s defaults carry over', () => {
    it('v1’s role="workspace" agent becomes the Genie 2 workspace’s default, matched by workspace and name', () => {
        const v1 = [
            { workspaceId: 'tynn', name: 'tynn', role: 'workspace' },
            { workspaceId: 'tynn', name: 'tynn-slave', role: null },
            { workspaceId: 'fancy', name: 'fancy', role: 'workspace' },
            { workspaceId: 'moic', name: 'moic', role: 'workspace' },
        ];
        const records = [
            { id: 'g-tynn', workspaceId: 'tynn', name: 'tynn' },
            { id: 'g-slave', workspaceId: 'tynn', name: 'tynn-slave' },
            { id: 'g-fancy', workspaceId: 'fancy', name: 'fancy' },
        ];
        // moic's v1 default has no Genie 2 record: nothing is guessed.
        expect(v1DefaultAgents(v1, records)).toEqual({ tynn: 'g-tynn', fancy: 'g-fancy' });
    });
});
