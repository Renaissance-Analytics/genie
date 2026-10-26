import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { JsonObject } from '@particle-academy/prism-mcp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { agentRecord, mintAgentId, type AgentRecord } from '../src/core/identity.js';
import { reachable, resolveAddress, type WorkspaceInboxSetting } from '../src/core/inbox.js';
import { AttentionStore } from '../src/main/attention-store.js';
import { InboxStore } from '../src/main/inbox-store.js';
import { genieTools, type Caller, type GenieToolsDeps, type Registration } from '../src/main/mcp-tools.js';

/**
 * AGENTINBOX IS TWO-WAY — whoever wrote to you can be answered, at the address their mail came from.
 *
 * Reported 2026-10-15: `claude:moic` (its workspace on the default "only this workspace", its own scope
 * `self`) mailed `claude:tynn` (workspace and scope both `all`). The mail arrived. tynn could not answer:
 * `list` showed `claude:moic` with `reachable: false`, `send` to it was refused, and sending to the
 * `from` the mail carried (`agent_…`) was "nobody at agent_…".
 *
 * The contract is Genie 1's, in its own words (genie `main/mcp/protocol.ts`, the agentinbox tool):
 * "when one messages you first, you may reply in that durable thread using the sender id from the
 * message" — and the owner's: "even if an agent is not 'visible' to the workstation, it is visible to
 * any agents that it talks to." The sender opened the conversation; its own send was the permission.
 *
 * The CONTROLS matter as much as the fix: a reply permission that leaked to an agent moic never wrote
 * to, or that turned a never-mailed agent reachable, would be a disclosure, not a convenience.
 */

const settings: Record<string, WorkspaceInboxSetting> = {
    'ws-moic': { scope: 'self' },
    'ws-tynn': { scope: 'all' },
    'ws-other': { scope: 'all' },
};
const workspaceSetting = (id: string): WorkspaceInboxSetting => settings[id] ?? { scope: 'self' };

const moic = agentRecord({ id: mintAgentId(), workspaceId: 'ws-moic', provider: 'claude', name: 'moic', accessScope: 'self' });
const tynn = agentRecord({ id: mintAgentId(), workspaceId: 'ws-tynn', provider: 'claude', name: 'tynn', accessScope: 'all' });
const stranger = agentRecord({ id: mintAgentId(), workspaceId: 'ws-other', provider: 'claude', name: 'stranger', accessScope: 'all' });
const roster: AgentRecord[] = [moic, tynn, stranger];

let dir: string;
let inbox: InboxStore;
let tools: Registration[];

const callers: Record<string, Caller> = {
    't-moic': { agentId: moic.id, agentName: 'moic', workspaceId: 'ws-moic', workspacePath: '/ws/moic' },
    't-tynn': { agentId: tynn.id, agentName: 'tynn', workspaceId: 'ws-tynn', workspacePath: '/ws/tynn' },
    't-stranger': { agentId: stranger.id, agentName: 'stranger', workspaceId: 'ws-other', workspacePath: '/ws/other' },
};

async function build(): Promise<void> {
    const attention = await AttentionStore.open(dir, inbox);
    const deps: GenieToolsDeps = {
        inbox,
        attention,
        roster: () => roster,
        resolveCaller: (terminalId) => callers[terminalId] ?? null,
        workspaceSetting,
        userActive: () => true,
        glow: () => true,
        thumbsUp: () => {},
    };
    tools = genieTools(deps);
}

async function inboxTool(terminalId: string, args: JsonObject) {
    const reg = tools.find((t) => t.definition.name === 'agentinbox')!;
    const result = await reg.handler({ terminalId, ...args }, { server: 'genie', tool: 'agentinbox', headers: {} });
    return { ...result, json: JSON.parse(result.text) as Record<string, unknown> };
}

async function reachableIn(terminalId: string): Promise<Record<string, boolean>> {
    const r = await inboxTool(terminalId, { action: 'list' });
    const peers = r.json.peers as Array<{ address: string; reachable: boolean }>;
    return Object.fromEntries(peers.map((p) => [p.address, p.reachable]));
}

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'genie2-inbox-reply-'));
    inbox = await InboxStore.open(dir);
    await build();
});

afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
});

describe('the reported case: moic mails tynn, tynn answers', () => {
    it('BEFORE moic writes, tynn cannot reach moic — the control that makes the reply below mean something', async () => {
        expect((await reachableIn('t-tynn'))['moic@ws-moic']).toBe(false);
        const refused = await inboxTool('t-tynn', { action: 'send', to: 'claude:moic', text: 'unsolicited' });
        expect(refused.isError).toBe(true);
        expect(refused.text).toMatch(/not reachable/);
        expect((await inbox.receive({ participant: moic.id })).messages).toEqual([]);
    });

    it('after moic writes, tynn sees moic reachable and its reply to `claude:moic` is delivered', async () => {
        const opened = await inboxTool('t-moic', { action: 'send', to: 'claude:tynn', text: 'can you look at this?' });
        expect(opened.isError).toBe(false);

        expect((await reachableIn('t-tynn'))['moic@ws-moic']).toBe(true);
        const reply = await inboxTool('t-tynn', { action: 'send', to: 'claude:moic', text: 'yes' });
        expect(reply.isError).toBe(false);
        expect(reply.json).toMatchObject({ ok: true, delivered: 1 });
        expect((await inbox.receive({ participant: moic.id })).messages.map((m) => m.text)).toEqual(['yes']);
    });

    it('the `from` on the mail tynn received is an address `send` resolves', async () => {
        await inboxTool('t-moic', { action: 'send', to: 'claude:tynn', text: 'ping' });
        const got = await inboxTool('t-tynn', { action: 'receive' });
        const from = (got.json.messages as Array<{ from: string }>)[0]!.from;
        expect(from).toBe(moic.id);

        const reply = await inboxTool('t-tynn', { action: 'send', to: from, text: 'pong' });
        expect(reply.isError).toBe(false);
        expect((await inbox.receive({ participant: moic.id })).messages.map((m) => m.text)).toEqual(['pong']);
    });

    it('the reply permission is durable: it survives Genie reopening the mail store', async () => {
        await inboxTool('t-moic', { action: 'send', to: 'claude:tynn', text: 'before the restart' });
        inbox = await InboxStore.open(dir);
        await build();
        const reply = await inboxTool('t-tynn', { action: 'send', to: 'claude:moic', text: 'after the restart' });
        expect(reply.isError).toBe(false);
    });
});

describe('CONTROLS: answering is not a hole', () => {
    it('an agent moic never wrote to still cannot reach moic — by address or by id', async () => {
        await inboxTool('t-moic', { action: 'send', to: 'claude:tynn', text: 'only tynn' });

        expect((await reachableIn('t-stranger'))['moic@ws-moic']).toBe(false);
        const byAddress = await inboxTool('t-stranger', { action: 'send', to: 'claude:moic', text: 'x' });
        expect(byAddress.isError).toBe(true);
        expect(byAddress.text).toMatch(/not reachable/);
        // Knowing the id is not permission: it resolves, and is then refused on permission.
        const byId = await inboxTool('t-stranger', { action: 'send', to: moic.id, text: 'x' });
        expect(byId.isError).toBe(true);
        expect(byId.text).toMatch(/not reachable/);
        expect((await inbox.receive({ participant: moic.id })).messages).toEqual([]);
    });

    it('writing TO someone earns nothing: tynn mailing moic first would not make moic answerable by tynn', () => {
        // Direction is the whole rule — the one who WROTE is the one who may be answered.
        const tynnWroteToMoic = (writer: string, reader: string) => writer === tynn.id && reader === moic.id;
        expect(reachable(tynn, moic, workspaceSetting, { wroteTo: tynnWroteToMoic })).toBe(false);
        const moicWroteToTynn = (writer: string, reader: string) => writer === moic.id && reader === tynn.id;
        expect(reachable(tynn, moic, workspaceSetting, { wroteTo: moicWroteToTynn })).toBe(true);
    });

    it('an id nobody holds is still "nobody", never a guess', async () => {
        const ghost = await inboxTool('t-tynn', { action: 'send', to: mintAgentId(), text: 'x' });
        expect(ghost.isError).toBe(true);
        expect(ghost.text).toMatch(/nobody at/);
    });
});

describe('addressing by the id mail carries', () => {
    it('resolveAddress resolves an agent id on the roster to exactly that agent, and an unknown one to none', () => {
        expect(resolveAddress(moic.id, roster)).toEqual({ kind: 'one', id: moic.id });
        expect(resolveAddress(mintAgentId(), roster)).toEqual({ kind: 'none' });
    });
});
