import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { JsonObject } from '@particle-academy/prism-mcp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { agentRecord, mintAgentId, type AgentRecord } from '../src/core/identity.js';
import type { WorkspaceInboxSetting } from '../src/core/inbox.js';
import { AttentionStore } from '../src/main/attention-store.js';
import { InboxStore } from '../src/main/inbox-store.js';
import { genieTools, type Caller, type Registration } from '../src/main/mcp-tools.js';

/**
 * WHO HAS ACCESS TO AN AGENT IS LIVE (genie#1188; the owner, 2026-10-25: "I should not have to restart an agent when I
 * change its permissions, including who has access to the agent"). The agent's own scope and its workspace's setting
 * are read on EVERY AgentInbox call — from the roster and the settings as they are at that moment — so a change is
 * obeyed by the very next `list` or `send`, from the same tool registration: nothing rebuilt, nobody restarted.
 * Both directions are proven on one registration — closing access, and opening it again.
 */

let dir: string;
let tools: Registration[];
let roster: AgentRecord[];
const settings: Record<string, WorkspaceInboxSetting> = {};

const atlas = () => roster.find((r) => r.name === 'atlas')!;
const callers: Record<string, Caller> = {};

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'genie2-access-live-'));
    const sender = agentRecord({ id: mintAgentId(), workspaceId: 'ws-a', provider: 'claude', name: 'scout', accessScope: 'all' });
    const target = agentRecord({ id: mintAgentId(), workspaceId: 'ws-b', provider: 'claude', name: 'atlas', accessScope: 'all' });
    roster = [sender, target];
    settings['ws-a'] = { scope: 'all' };
    settings['ws-b'] = { scope: 'all' };
    callers['t-scout'] = { agentId: sender.id, agentName: 'scout', workspaceId: 'ws-a', workspacePath: '/ws/a' };
    const inbox = await InboxStore.open(dir);
    const attention = await AttentionStore.open(dir, inbox);
    // ONE registration for the whole test: what an agent's running session holds.
    tools = genieTools({
        inbox, attention,
        roster: () => roster,
        resolveCaller: (t) => callers[t] ?? null,
        workspaceSetting: (id) => settings[id] ?? { scope: 'self' },
        userActive: () => true, glow: () => true, thumbsUp: () => {},
    });
});

afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
});

async function inboxTool(args: JsonObject) {
    const reg = tools.find((t) => t.definition.name === 'agentinbox')!;
    const result = await reg.handler({ terminalId: 't-scout', ...args }, { server: 'genie', tool: 'agentinbox', headers: {} });
    return JSON.parse(result.text) as Record<string, unknown>;
}
const reachableAtlas = async () => ((await inboxTool({ action: 'list' })).peers as Array<{ name: string; reachable: boolean }>).find((p) => p.name === 'atlas')!.reachable;
const sendToAtlas = async () => (await inboxTool({ action: 'send', to: 'claude:atlas', text: 'hello' })).ok;

describe("an agent's own access, changed between two calls", () => {
    it('open → closed → open again: list and send follow at once, from the same registration', async () => {
        // POSITIVE CONTROL first: reachable, and a send lands.
        expect(await reachableAtlas()).toBe(true);
        expect(await sendToAtlas()).toBe(true);

        // Closed (what registry.setAccessScope saves): the very next calls obey it.
        roster = roster.map((r) => (r.id === atlas().id ? { ...r, accessScope: 'none' } : r));
        expect(await reachableAtlas()).toBe(false);
        expect(await sendToAtlas()).toBe(false);

        // Opened again: no restart in between, and it is reachable once more.
        roster = roster.map((r) => (r.id === atlas().id ? { ...r, accessScope: 'all' } : r));
        expect(await reachableAtlas()).toBe(true);
        expect(await sendToAtlas()).toBe(true);
    });
});

describe("the workspace's access setting, changed between two calls", () => {
    it('all → only this workspace: an agent in another workspace loses it at once; back to all, it has it again', async () => {
        expect(await reachableAtlas()).toBe(true);
        settings['ws-b'] = { scope: 'self' };
        expect(await reachableAtlas()).toBe(false);
        expect(await sendToAtlas()).toBe(false);
        settings['ws-b'] = { scope: 'all' };
        expect(await reachableAtlas()).toBe(true);
    });
});
