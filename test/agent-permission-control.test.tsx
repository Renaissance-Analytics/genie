import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentRecord } from '../src/core/identity.js';
import { AGENT_SCOPED_METHODS, capabilityOf } from '../src/core/remote-protocol.js';
import { setPermissions, type AgentOpsPorts } from '../src/main/agent-ops-host.js';
import { Registry } from '../src/main/registry.js';
import { Store } from '../src/main/store.js';
import { AgentView, type AgentOpsProps } from '../src/renderer/components/AgentView.js';

/**
 * WHAT A CLAUDE AGENT MAY DO, CHOSEN ON ITS AGENT VIEW (the owner: "the agent said 'shell' was not allowed"). A Claude
 * session cannot ask a person mid-turn, so each Claude agent carries a setting: all tools (the default) or edits only
 * (file edits go through; shell is refused). The record has had the field since #184; this is the control. It is a
 * Claude setting only — Codex asks in the chat, so a Codex agent has no such control and a request for one is refused
 * with that reason. A change applies when the session next starts, and the view says so.
 */
let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'genie2-perm-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe('the record', () => {
    it('set and persisted across a reload; unknown agent → null', async () => {
        const registry = new Registry(new Store(dir));
        await registry.load({ name: 'alphar', healthy: true });
        await registry.addWorkspace({ id: 'tynn', path: '/w/tynn' });
        const a = await registry.register({ workspaceId: 'tynn', provider: 'claude', name: 'atlas' });
        expect(await registry.setPermissions(a.id, 'edits')).toMatchObject({ permissions: 'edits' });
        const again = new Registry(new Store(dir));
        await again.load({ name: 'alphar', healthy: true });
        expect(again.listAgents().find((r) => r.id === a.id)?.permissions).toBe('edits');
        expect(await registry.setPermissions('agent_nope' as never, 'all')).toBeNull();
    });
});

describe('the operation', () => {
    const ports = (record: AgentRecord): AgentOpsPorts => {
        let current = record;
        return { registry: { find: (id: string) => (id === current.id ? current : null), setPermissions: async (_id: unknown, permissions: 'all' | 'edits') => { current = { ...current, permissions }; return current; } } } as unknown as AgentOpsPorts;
    };
    const rec = (provider: string) => ({ id: 'agent_a', workspaceId: 'tynn', provider, name: 'atlas', mode: 'manual', accessScope: 'self' }) as unknown as AgentRecord;

    it('a Claude agent takes it; a Codex agent is refused with the reason; an unknown one is refused', async () => {
        expect(await setPermissions(ports(rec('claude')), 'agent_a', 'edits')).toMatchObject({ ok: true, record: { permissions: 'edits' } });
        const codex = await setPermissions(ports(rec('codex')), 'agent_a', 'edits');
        expect(codex).toMatchObject({ ok: false });
        expect((codex as { reason: string }).reason).toMatch(/Codex asks in the chat/);
        expect(await setPermissions(ports(rec('claude')), 'agent_zz', 'all')).toMatchObject({ ok: false });
    });

    it('is a write a remote guest needs, scoped to the agent', () => {
        expect(capabilityOf('agents.setPermissions')).toBe('write');
        expect(AGENT_SCOPED_METHODS).toContain('agents.setPermissions');
    });
});

describe('the control', () => {
    const ops = (over: Partial<AgentOpsProps> = {}): AgentOpsProps => ({
        deletePreview: null, diagnosis: null, lastOutcome: null, budgetUsd: null, mode: 'manual', accessScope: 'self', permissions: 'all',
        onRestart: () => {}, onSwitchDriver: () => {}, onDiagnose: () => {}, onPreviewDelete: () => {}, onConfirmDelete: () => {}, onCancelDelete: () => {}, onSetBudget: () => {},
        onSetMode: () => {}, onSetAccessScope: () => {}, onSetPermissions: () => {},
        ...over,
    });
    const render = (provider: string, o?: AgentOpsProps) => renderToStaticMarkup(
        <AgentView agent={{ id: 'agent_a', name: 'atlas', provider, fidelity: 'declared', cwd: '/w/tynn' }} session={null} rows={[]} tab="settings" lanes={null} at={null} selectedId={null} turns={0} cost={null} onNavigate={() => {}} onSelect={() => {}} ops={o} />,
    );

    it('a Claude agent: a select of the two, the current one selected, and when it applies', () => {
        const html = render('claude', ops({ permissions: 'edits' }));
        expect(html).toContain('data-permissions="edits"');
        expect(html).toMatch(/<option value="all"[^>]*>all tools<\/option>/);
        expect(html).toMatch(/<option value="edits" selected=""[^>]*>edits only — shell refused<\/option>/);
        expect(html).toMatch(/applies at once while .* is idle, or when its turn ends/);
        expect(html).not.toMatch(/applies when .*next starts/);
    });

    it('a Codex agent has no such control (positive control: the same ops on a Claude agent draw it)', () => {
        expect(render('codex', ops())).not.toContain('data-permissions=');
        expect(render('claude', ops())).toContain('data-permissions="all"');
    });
});
