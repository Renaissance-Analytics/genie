import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { JsonObject } from '@particle-academy/prism-mcp';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { agentRecord, mintAgentId, type AgentRecord } from '../src/core/identity.js';
import { AttentionStore } from '../src/main/attention-store.js';
import { InboxStore } from '../src/main/inbox-store.js';
import { genieTools, type Caller, type Registration } from '../src/main/mcp-tools.js';

/*
 * `agentinbox` ACROSS WORKSTATIONS (P9): `list` adds the other stations' agents, each as `name@workspace@station`;
 * `send` to such an address (or to the `peer:` from of mail received from one) goes through the cross-station host.
 * `name@workspace` still means THIS host, first. A file does not travel yet (P9.6), so a station send with one is refused.
 */

let dir: string;
let tools: Registration[];
let roster: AgentRecord[];
const callers: Record<string, Caller> = {};
const xsend = vi.fn();

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'genie-xstation-mcp-'));
    const atlas = agentRecord({ id: mintAgentId(), workspaceId: 'ws', provider: 'claude', name: 'atlas', accessScope: 'all' });
    const bolt = agentRecord({ id: mintAgentId(), workspaceId: 'ws', provider: 'claude', name: 'bolt', accessScope: 'all' });
    roster = [atlas, bolt];
    callers.t = { agentId: atlas.id, agentName: 'atlas', workspaceId: 'ws', workspacePath: '/ws' };
    const inbox = await InboxStore.open(dir);
    const attention = await AttentionStore.open(dir, inbox);
    xsend.mockReset();
    xsend.mockImplementation(async (_caller: AgentRecord, to: string) => (to.endsWith('@desk') ? null : { ok: true, delivered: true, queued: false, messageId: 'msg_x' }));
    tools = genieTools({
        inbox, attention,
        roster: () => roster,
        workspaceSlugs: () => new Map([['ws', 'p8x']]),
        resolveCaller: (t) => callers[t] ?? null,
        userActive: () => true, glow: () => true, thumbsUp: () => {},
        crossStation: {
            peers: async () => [{ address: 'bolt@p8x@laptop', name: 'bolt', workspace: 'p8x', station: 'laptop', reachable: true }],
            send: xsend,
        },
    });
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

async function inboxTool(args: JsonObject) {
    const reg = tools.find((t) => t.definition.name === 'agentinbox')!;
    const result = await reg.handler({ terminalId: 't', ...args }, { server: 'genie', tool: 'agentinbox', headers: {} });
    return JSON.parse(result.text) as Record<string, unknown>;
}

describe('agentinbox across workstations', () => {
    it('list: this host’s peers first, then the other stations’ agents in full', async () => {
        const peers = (await inboxTool({ action: 'list' })).peers as Array<{ address: string; station?: string }>;
        expect(peers.map((p) => p.address)).toEqual(['bolt@p8x', 'bolt@p8x@laptop']);
        expect(peers[1]!.station).toBe('laptop');
    });

    it('send to name@workspace@station goes through the cross-station host and says what happened', async () => {
        const r = await inboxTool({ action: 'send', to: 'bolt@p8x@laptop', text: 'hi' });
        expect(r).toMatchObject({ ok: true, delivered: 1, messageId: 'msg_x' });
        expect(xsend).toHaveBeenCalledWith(expect.objectContaining({ name: 'atlas' }), 'bolt@p8x@laptop', 'hi');
    });

    it('a reply to the peer: from of received mail goes the same way', async () => {
        await inboxTool({ action: 'send', to: 'peer:01m88e0vzh4a36rj22h53hfcwr:bolt@p8x', text: 'back' });
        expect(xsend).toHaveBeenCalledWith(expect.anything(), 'peer:01m88e0vzh4a36rj22h53hfcwr:bolt@p8x', 'back');
    });

    it('queued is said as queued, not delivered', async () => {
        xsend.mockResolvedValueOnce({ ok: true, delivered: false, queued: true, messageId: 'msg_q' });
        expect(await inboxTool({ action: 'send', to: 'bolt@p8x@laptop', text: 'later' })).toMatchObject({ ok: true, delivered: 0, queued: true, messageId: 'msg_q' });
    });

    it('a refusal there is the send’s error', async () => {
        xsend.mockResolvedValueOnce({ ok: false, reason: 'nobody at ghost@p8x on laptop' });
        const reg = tools.find((t) => t.definition.name === 'agentinbox')!;
        const result = await reg.handler({ terminalId: 't', action: 'send', to: 'ghost@p8x@laptop', text: 'x' }, { server: 'genie', tool: 'agentinbox', headers: {} });
        expect(result.isError).toBe(true);
        expect(result.text).toMatch(/nobody at ghost@p8x on laptop/);
    });

    it('this host’s own station word is local: name@workspace still reaches the local agent', async () => {
        const r = await inboxTool({ action: 'send', to: 'bolt@p8x@desk', text: 'local' });
        expect(r).toMatchObject({ ok: true, delivered: 1 });
        expect(await inboxTool({ action: 'send', to: 'bolt@p8x', text: 'plain' })).toMatchObject({ ok: true, delivered: 1 });
        expect(xsend).toHaveBeenCalledTimes(1); // only the station form asked; the plain one never did
    });

    it('a file does not cross workstations yet: refused before anything is sent', async () => {
        const reg = tools.find((t) => t.definition.name === 'agentinbox')!;
        const result = await reg.handler({ terminalId: 't', action: 'send', to: 'bolt@p8x@laptop', text: 'x', attachments: ['a.txt'] }, { server: 'genie', tool: 'agentinbox', headers: {} });
        expect(result.isError).toBe(true);
        expect(xsend).not.toHaveBeenCalled();
    });
});
