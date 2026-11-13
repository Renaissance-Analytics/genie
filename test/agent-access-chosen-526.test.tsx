import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { JsonObject } from '@particle-academy/prism-mcp';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { accessChoice, accessFor, toggleChosen } from '../src/core/agent-access.js';
import type { AgentRecord } from '../src/core/identity.js';
import { HUMAN, reachable } from '../src/core/inbox.js';
import { AGENT_SCOPED_METHODS, capabilityOf } from '../src/core/remote-protocol.js';
import { setAccessAgents, type AgentOpsPorts } from '../src/main/agent-ops-host.js';
import { AttentionStore } from '../src/main/attention-store.js';
import { toolRoster } from '../src/main/genie-tool-deps.js';
import { InboxStore } from '../src/main/inbox-store.js';
import { CallerBook, sessionCallerOf } from '../src/main/mcp-callers.js';
import { genieTools, type Registration } from '../src/main/mcp-tools.js';
import { Registry } from '../src/main/registry.js';
import { Store } from '../src/main/store.js';
import { AgentView, type AgentOpsProps } from '../src/renderer/components/AgentView.js';

/**
 * "WHO MAY MESSAGE <agent>" CAN NAME AGENTS (Tynn #526; the owner, 2026-11-08, on weaver's settings: "the agent access
 * settings needs to let me choose other agents too, not just these"). Per-agent access (#1664) offered nobody, this
 * workspace, or any workspace here. Now a list of chosen agents, kept on the RECIPIENT, alone or on top of this
 * workspace, and enforced where mail is sent: agentinbox send, driven here through the real Registry and the roster the
 * host hands the tools (`toolRoster`).
 */
let dir: string;
let registry: Registry;
let tools: Registration[];
const book = new CallerBook();
const REFUSAL = /is not reachable from .*: the target's workspace setting or agent scope does not allow it \(permission, not liveness\)/;

/** This test's setup, so afterEach removes the folder only once nothing is still writing into it. */
let setup: Promise<void> = Promise.resolve();

beforeEach(async () => { setup = prepare(); await setup; });
async function prepare(): Promise<void> {
    dir = await mkdtemp(join(tmpdir(), 'genie2-access-chosen-'));
    registry = new Registry(new Store(dir));
    await registry.load({ name: 'alphar', healthy: true });
    for (const id of ['shop', 'docs', 'lab']) await registry.addWorkspace({ id, path: join(dir, id) });
    await registry.register({ workspaceId: 'shop', provider: 'claude', name: 'weaver' });
    await registry.register({ workspaceId: 'shop', provider: 'claude', name: 'kai' });
    await registry.register({ workspaceId: 'docs', provider: 'codex', name: 'wren' });
    await registry.register({ workspaceId: 'lab', provider: 'claude', name: 'finn' });
    const inbox = await InboxStore.open(dir);
    const attention = await AttentionStore.open(dir, inbox);
    tools = genieTools({
        inbox, attention,
        roster: () => toolRoster(registry),
        resolveCaller: (key) => sessionCallerOf(book, key, registry, join(dir, 'osa')),
        userActive: () => true, glow: () => true, thumbsUp: () => {},
    });
}
/*
 * The setup can outlive its hook (Tynn #660): it makes some eleven durable writes (three workspaces, four agents, the stores),
 * and on a Windows test VM in one of the suite's disk bursts each took 0.7-3 s (measured, 2026-11-13). Vitest then ran this
 * hook while the setup was still writing, and the removal failed with ENOTEMPTY under a file just written. So it waits for this
 * test's setup to end, then removes the folder, retrying while Windows still holds a handle that was just closed.
 */
afterEach(async () => {
    await setup.catch(() => undefined);
    await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
});

const all = (): readonly AgentRecord[] => [...registry.listAgents()];
const agent = (name: string): AgentRecord => all().find((a) => a.name === name)!;
async function inbox(as: AgentRecord, args: JsonObject) {
    const reg = tools.find((t) => t.definition.name === 'agentinbox')!;
    const result = await reg.handler({ terminalId: book.keyFor(as.id), ...args }, { server: 'genie', tool: 'agentinbox', headers: {} });
    return JSON.parse(result.text) as Record<string, unknown>;
}
const send = (from: string, to = 'weaver@shop') => inbox(agent(from), { action: 'send', to, text: `hello from ${from}` });
const listed = async (from: string) => ((await inbox(agent(from), { action: 'list' })).peers as Array<{ address: string; reachable: boolean }>).find((p) => p.address === 'weaver@shop')?.reachable;

describe('chosen agents only: on the recipient, enforced at agentinbox send', () => {
    it('a chosen agent in another workspace gets through; one not chosen is refused with today’s reason, its own workspace too', async () => {
        await registry.setAccessScope(agent('weaver').id, 'none');
        expect(await registry.setAccessAgents(agent('weaver').id, [agent('wren').id])).toMatchObject({ accessAgents: [agent('wren').id] });
        expect(await send('wren')).toMatchObject({ ok: true });
        const finn = await send('finn');
        expect(finn.ok).not.toBe(true);
        expect(String(finn.error ?? finn.reason ?? JSON.stringify(finn))).toMatch(REFUSAL);
        // Chosen ONLY: this workspace is not let in.
        expect((await send('kai')).ok).not.toBe(true);
    });

    it('agentinbox list says reachable for the chosen agent and not for the others', async () => {
        await registry.setAccessScope(agent('weaver').id, 'none');
        await registry.setAccessAgents(agent('weaver').id, [agent('wren').id]);
        expect(await listed('wren')).toBe(true);
        expect(await listed('finn')).toBe(false);
        expect(await listed('kai')).toBe(false);
    });

    it('CONTROL: with no list, the same scope refuses wren', async () => {
        await registry.setAccessScope(agent('weaver').id, 'none');
        expect((await send('wren')).ok).not.toBe(true);
        expect(await listed('wren')).toBe(false);
    });
});

describe('this workspace plus chosen agents', () => {
    it('its own workspace and the chosen agent get through; another workspace does not', async () => {
        await registry.setAccessScope(agent('weaver').id, 'self');
        await registry.setAccessAgents(agent('weaver').id, [agent('wren').id]);
        expect(await send('kai')).toMatchObject({ ok: true });
        expect(await send('wren')).toMatchObject({ ok: true });
        expect((await send('finn')).ok).not.toBe(true);
    });
});

describe('the person and genie@system are not affected', () => {
    it('the OS agent sends to an agent with an empty chosen list; the person reaches it too', async () => {
        await registry.setAccessScope(agent('weaver').id, 'none');
        await registry.setAccessAgents(agent('weaver').id, []);
        const os = registry.osAgent()!;
        expect(await inbox(os, { action: 'send', to: 'weaver@shop', text: 'hi' })).toMatchObject({ ok: true });
        expect(reachable(HUMAN, agent('weaver'))).toBe(true);
        expect(reachable(agent('weaver'), HUMAN)).toBe(true);
    });
});

describe('a deleted agent leaves the list; a hibernated one stays but cannot send', () => {
    it('deleted: dropped from every list it was on', async () => {
        await registry.setAccessAgents(agent('weaver').id, [agent('wren').id, agent('finn').id]);
        const wren = agent('wren').id;
        expect(await registry.forget(wren)).toBe(true);
        expect(agent('weaver').accessAgents).toEqual([agent('finn').id]);
    });

    it('a removed workspace’s agents are dropped too', async () => {
        await registry.setAccessAgents(agent('weaver').id, [agent('wren').id, agent('finn').id]);
        await registry.forgetWorkspace('docs');
        expect(agent('weaver').accessAgents).toEqual([agent('finn').id]);
    });

    it('hibernated: kept on the list, refused while asleep, through again once redocked', async () => {
        await registry.setAccessScope(agent('weaver').id, 'none');
        const wren = agent('wren');
        await registry.setAccessAgents(agent('weaver').id, [wren.id]);
        await registry.setAsleep('docs', true);
        expect(agent('weaver').accessAgents).toEqual([wren.id]);
        expect((await inbox(wren, { action: 'send', to: 'weaver@shop', text: 'asleep' })).ok).not.toBe(true);
        await registry.setAsleep('docs', false);
        expect(await send('wren')).toMatchObject({ ok: true });
    });

    it('kept across a reload', async () => {
        await registry.setAccessAgents(agent('weaver').id, [agent('wren').id]);
        const again = new Registry(new Store(dir));
        await again.load({ name: 'alphar', healthy: true });
        expect(again.listAgents().find((a) => a.name === 'weaver')?.accessAgents).toEqual([agent('wren').id]);
    });
});

describe('the operation', () => {
    const portsOn = (r: Registry): AgentOpsPorts => ({ registry: r } as unknown as AgentOpsPorts);

    it('keeps known agents once each; refuses an unknown agent, the agent itself, and genie@system is not needed', async () => {
        const weaver = agent('weaver');
        const wren = agent('wren').id;
        expect(await setAccessAgents(portsOn(registry), weaver.id, [wren, wren])).toMatchObject({ ok: true, record: { accessAgents: [wren] } });
        expect(await setAccessAgents(portsOn(registry), weaver.id, ['agent_' + 'z'.repeat(32)])).toMatchObject({ ok: false });
        expect(await setAccessAgents(portsOn(registry), weaver.id, [weaver.id])).toMatchObject({ ok: false });
        expect(await setAccessAgents(portsOn(registry), weaver.id, [registry.osAgent()!.id])).toMatchObject({ ok: true, record: { accessAgents: [] } });
        // null = no chosen agents at all (the choice is off).
        const off = await setAccessAgents(portsOn(registry), weaver.id, null);
        expect(off).toMatchObject({ ok: true });
        expect((off as { record: AgentRecord }).record.accessAgents).toBeUndefined();
    });

    it('is a write a remote guest needs, scoped to the agent', () => {
        expect(capabilityOf('agents.setAccessAgents' as Parameters<typeof capabilityOf>[0])).toBe('write');
        expect(AGENT_SCOPED_METHODS as readonly string[]).toContain('agents.setAccessAgents');
    });
});

describe('the choice, as words', () => {
    it('five choices from scope + list, and back', () => {
        expect(accessChoice({ accessScope: 'none' })).toBe('none');
        expect(accessChoice({ accessScope: 'self' })).toBe('self');
        expect(accessChoice({ accessScope: 'specific' })).toBe('self');
        expect(accessChoice({ accessScope: 'all' })).toBe('all');
        expect(accessChoice({ accessScope: 'none', accessAgents: [] })).toBe('chosen');
        expect(accessChoice({ accessScope: 'self', accessAgents: ['a'] })).toBe('self+chosen');
        expect(accessChoice({ accessScope: 'all', accessAgents: ['a'] })).toBe('all');
        expect(accessFor('chosen', ['a'])).toEqual({ scope: 'none', agents: ['a'] });
        expect(accessFor('self+chosen', null)).toEqual({ scope: 'self', agents: [] });
        expect(accessFor('self', ['a'])).toEqual({ scope: 'self', agents: null });
        expect(accessFor('all', ['a'])).toEqual({ scope: 'all', agents: null });
        expect(toggleChosen(['a', 'b'], 'c', true)).toEqual(['a', 'b', 'c']);
        // An agent the picker does not show (a hibernated one) is kept when another is toggled.
        expect(toggleChosen(['asleep', 'b'], 'b', false)).toEqual(['asleep']);
    });
});

describe('the control on the agent’s settings', () => {
    const candidates = [
        { id: 'agent_wren', name: 'wren', provider: 'codex', workspaceName: 'Docs' },
        { id: 'agent_finn', name: 'finn', provider: 'claude', workspaceName: 'Lab' },
    ];
    const ops = (over: Partial<AgentOpsProps> = {}): AgentOpsProps => ({
        deletePreview: null, diagnosis: null, lastOutcome: null, budgetUsd: null, mode: 'manual', accessScope: 'self', permissions: 'all',
        onRestart: () => {}, onSwitchDriver: () => {}, onDiagnose: () => {}, onPreviewDelete: () => {}, onConfirmDelete: () => {}, onCancelDelete: () => {}, onSetBudget: () => {},
        onSetMode: () => {}, onSetAccessScope: () => {}, onSetPermissions: () => {}, onSetAccessAgents: () => {}, accessCandidates: candidates,
        ...over,
    });
    const render = (o: AgentOpsProps) => renderToStaticMarkup(
        <AgentView agent={{ id: 'agent_weaver', name: 'weaver', provider: 'claude', fidelity: 'declared', cwd: '/w/shop' }} session={null} rows={[]} tab="settings" settingsSection="permissions" lanes={null} at={null} selectedId={null} turns={0} cost={null} onNavigate={() => {}} onSelect={() => {}} ops={o} />,
    );

    it('offers chosen agents and this workspace plus chosen agents', () => {
        const html = render(ops());
        expect(html).toMatch(/<option value="chosen"[^>]*>chosen agents<\/option>/);
        expect(html).toMatch(/<option value="self\+chosen"[^>]*>this workspace \+ chosen agents<\/option>/);
    });

    it('chosen: the picker lists each agent with its logo, name and workspace, the chosen one checked', () => {
        const html = render(ops({ accessScope: 'none', accessAgents: ['agent_wren'] }));
        expect(html).toMatch(/<option value="chosen" selected=""/);
        expect(html).toContain('data-access-picker');
        expect(html).toMatch(/data-access-candidate="agent_wren"[\s\S]*wren[\s\S]*Docs/);
        expect(html).toMatch(/data-access-candidate="agent_finn"[\s\S]*finn[\s\S]*Lab/);
        expect(html).toMatch(/data-access-candidate="agent_wren"[\s\S]*?data-provider-logo/);
        expect(html).toMatch(/data-access-candidate="agent_wren"[^>]*data-chosen="true"/);
        expect(html).toMatch(/data-access-candidate="agent_finn"[^>]*data-chosen="false"/);
    });

    it('CONTROL: this workspace alone draws no picker', () => {
        expect(render(ops())).not.toContain('data-access-picker');
    });
});
