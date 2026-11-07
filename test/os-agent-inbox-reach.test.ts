import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { JsonObject } from '@particle-academy/prism-mcp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentRecord } from '../src/core/identity.js';
import { AttentionStore } from '../src/main/attention-store.js';
import * as toolDeps from '../src/main/genie-tool-deps.js';
import { InboxStore } from '../src/main/inbox-store.js';
import { CallerBook, sessionCallerOf } from '../src/main/mcp-callers.js';
import { genieTools, type Registration } from '../src/main/mcp-tools.js';
import { Registry } from '../src/main/registry.js';
import { Store } from '../src/main/store.js';

/**
 * GENIE (genie@system, the OS agent) CAN MESSAGE EVERY AGENT (Tynn story #385; the owner on beta.59: its `agentinbox list`
 * showed every peer `reachable: false`, and `send` was refused for the target's workspace setting).
 *
 * `reachable()` lets the OS agent through (core/inbox.ts `isOsAgent(from)`), and its session resolves to its own record
 * (mcp-callers.ts `sessionCallerOf`). But agentinbox looks the CALLER up in the tools' roster (mcp-tools.ts
 * `deps.roster().find(r => r.id === caller.agentId)`), and main.ts built that roster from the snapshot's WORKSPACES —
 * which never include Genie's own workspace — so the OS agent was not in it, `me` was undefined, and every peer read
 * unreachable. The roster is every agent the registry knows (`toolRoster`), the OS agent included.
 *
 * Driven through the real path: a loaded Registry (which seeds the OS agent), the OS agent's session key resolved by
 * `sessionCallerOf`, the roster main.ts passes. Regular agents' reachability is unchanged (the controls).
 */
let dir: string;
let registry: Registry;
let tools: Registration[];
const book = new CallerBook();

type ToolRoster = (r: Pick<Registry, 'listAgents'>) => readonly AgentRecord[];
const toolRoster = (toolDeps as Record<string, unknown>)['toolRoster'] as ToolRoster | undefined;

beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'genie2-os-inbox-'));
    registry = new Registry(new Store(dir));
    await registry.load({ name: 'alphar', healthy: true });
    await registry.addWorkspace({ id: 'shop', path: join(dir, 'shop') });
    await registry.addWorkspace({ id: 'docs', path: join(dir, 'docs') });
    await registry.register({ workspaceId: 'shop', provider: 'claude', name: 'kai' }); // accessScope defaults to self
    const wren = await registry.register({ workspaceId: 'docs', provider: 'codex', name: 'wren' });
    await registry.setAccessScope(wren.id, 'all');
    const inbox = await InboxStore.open(dir);
    const attention = await AttentionStore.open(dir, inbox);
    tools = genieTools({
        inbox,
        attention,
        // THE ROSTER main.ts hands the tools.
        roster: () => (toolRoster ? toolRoster(registry) : []),
        resolveCaller: (key) => sessionCallerOf(book, key, registry, join(dir, 'osa')),
        userActive: () => true,
        glow: () => true,
        thumbsUp: () => {},
    });
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

const agent = (name: string): AgentRecord => registry.listAgents().find((a) => a.name === name)!;
async function inbox(as: AgentRecord, args: JsonObject) {
    const reg = tools.find((t) => t.definition.name === 'agentinbox')!;
    const result = await reg.handler({ terminalId: book.keyFor(as.id), ...args }, { server: 'genie', tool: 'agentinbox', headers: {} });
    return { ...result, json: JSON.parse(result.text) as Record<string, unknown> };
}
async function reach(as: AgentRecord): Promise<Record<string, boolean>> {
    const peers = ((await inbox(as, { action: 'list' })).json['peers'] ?? []) as Array<{ address: string; reachable: boolean }>;
    return Object.fromEntries(peers.map((p) => [p.address, p.reachable]));
}

describe('the OS agent reaches every agent', () => {
    it('positive control: the OS agent exists, and its session key resolves to it', () => {
        const os = registry.osAgent();
        expect(os).not.toBeNull();
        expect(sessionCallerOf(book, book.keyFor(os!.id), registry, join(dir, 'osa'))).toMatchObject({ agentId: os!.id, agentName: 'genie' });
    });

    it('list: every peer is reachable from genie@system, the self-scoped one in a self-only workspace too', async () => {
        expect(toolRoster, 'toolRoster in genie-tool-deps.ts').toBeTypeOf('function');
        const r = await reach(registry.osAgent()!);
        expect(r['kai@shop']).toBe(true);
        expect(r['wren@docs']).toBe(true);
    });

    it('send: delivered, not refused', async () => {
        const sent = await inbox(registry.osAgent()!, { action: 'send', to: 'kai@shop', text: 'hello from genie' });
        expect(sent.json).toMatchObject({ ok: true });
    });
});

describe('controls: a regular agent’s reach is what it was', () => {
    it('wren (docs) cannot open a conversation with kai (self scope, self-only workspace); kai reaches wren (open to all); both reach genie', async () => {
        const fromWren = await reach(agent('wren'));
        expect(fromWren['kai@shop']).toBe(false);
        expect(fromWren['genie@system']).toBe(true);
        const fromKai = await reach(agent('kai'));
        expect(fromKai['wren@docs']).toBe(true);
        expect(fromKai['genie@system']).toBe(true);
    });
});

describe('main.ts hands the tools that roster', () => {
    it('the window’s roster is toolRoster(registry), not the snapshot’s workspaces', () => {
        const code = readFileSync('src/main/main.ts', 'utf8').split(/\r?\n/).filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
        expect(code).not.toMatch(/const roster = \(\) => \(registry!\.snapshot\(\)\.workspaces/);
        expect(code).toMatch(/const roster = \(\) => toolRoster\(registry!\)/);
    });
});
