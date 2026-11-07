import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { JsonObject } from '@particle-academy/prism-mcp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { agentRecord, mintAgentId, type AgentRecord } from '../src/core/identity.js';
import { AttentionStore } from '../src/main/attention-store.js';
import { InboxStore } from '../src/main/inbox-store.js';
import { genieTools, type Caller, type Registration } from '../src/main/mcp-tools.js';

/**
 * WHO HAS ACCESS TO AN AGENT IS LIVE (genie#1188; the owner, 2026-10-25: "I should not have to restart an agent when I
 * change its permissions, including who has access to the agent"). The agent's own scope
 * is read on EVERY AgentInbox call from the current roster, so a change is
 * obeyed by the very next `list` or `send`, from the same tool registration: nothing rebuilt, nobody restarted.
 * Both directions are proven on one registration — closing access, and opening it again.
 */

let dir: string;
let tools: Registration[];
let roster: AgentRecord[];

const atlas = () => roster.find((r) => r.name === 'atlas')!;
const callers: Record<string, Caller> = {};

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'genie2-access-live-'));
    const sender = agentRecord({ id: mintAgentId(), workspaceId: 'ws-a', provider: 'claude', name: 'scout', accessScope: 'all' });
    const target = agentRecord({ id: mintAgentId(), workspaceId: 'ws-b', provider: 'claude', name: 'atlas', accessScope: 'all' });
    roster = [sender, target];
    callers['t-scout'] = { agentId: sender.id, agentName: 'scout', workspaceId: 'ws-a', workspacePath: '/ws/a' };
    const inbox = await InboxStore.open(dir);
    const attention = await AttentionStore.open(dir, inbox);
    // ONE registration for the whole test: what an agent's running session holds.
    tools = genieTools({
        inbox, attention,
        roster: () => roster,
        resolveCaller: (t) => callers[t] ?? null,
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

describe("the sender's access scope is not an outgoing restriction", () => {
    it('closing the sender still lets it reach an open target; closing the target refuses the next send', async () => {
        expect(await reachableAtlas()).toBe(true);
        roster = roster.map((r) => r.name === 'scout' ? { ...r, accessScope: 'none' } : r);
        expect(await reachableAtlas()).toBe(true);
        expect(await sendToAtlas()).toBe(true);
        roster = roster.map((r) => r.name === 'atlas' ? { ...r, accessScope: 'none' } : r);
        expect(await reachableAtlas()).toBe(false);
        expect(await sendToAtlas()).toBe(false);
    });
});
