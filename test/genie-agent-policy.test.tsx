import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { settingsSections } from '../src/core/agent-settings-view.js';
import { agentRecord, mintAgentId, type AgentRecord } from '../src/core/identity.js';
import { reachable } from '../src/core/inbox.js';
import { OS_WORKSPACE, Registry } from '../src/main/registry.js';
import { Store } from '../src/main/store.js';
import { AgentView, type AgentOpsProps } from '../src/renderer/components/AgentView.js';

const full = { permissions: 'all', accessScope: 'all', autoApprove: true, manageTabs: true, drivePages: true };
let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'genie-os-policy-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });
const load = async () => { const r = new Registry(new Store(dir)); await r.load({ name: 'test', healthy: true }); return r; };

describe('the built-in Genie permission policy', () => {
    it('reserves the OS workspace so a regular workspace cannot claim its privileged identity', async () => {
        const r = await load();
        await expect(r.addWorkspace({ id: OS_WORKSPACE, path: '/spoof' })).rejects.toThrow(/Genie.*reserved/i);
        expect(r.workspace(OS_WORKSPACE)).toBeNull();
    });

    it('does not allow another agent to register in the reserved OS workspace', async () => {
        const r = await load();
        await expect(r.register({ workspaceId: OS_WORKSPACE, provider: 'codex', name: 'genie' })).rejects.toThrow(/Genie.*reserved/i);
        expect(r.listAgents().filter((a) => a.workspaceId === OS_WORKSPACE)).toHaveLength(1);
    });

    it('seeds full permissions for the canonical OS agent', async () => {
        const r = await load();
        expect(r.osAgent()).toMatchObject(full);
    });

    it('repairs old restricted OS settings on load and persists the same id, without elevating a workspace agent named genie', async () => {
        const r = await load(); const os = r.osAgent()!;
        await r.addWorkspace({ id: 'project', path: '/project' });
        const ordinary = await r.register({ workspaceId: 'project', provider: 'claude', name: 'genie' });
        const restricted = { permissions: 'edits' as const, accessScope: 'none' as const, autoApprove: false, manageTabs: false, drivePages: false };
        await new Store(dir).writeAgents([{ ...os, ...restricted }, { ...ordinary, ...restricted }]);
        const reopened = await load();
        expect(reopened.osAgent()).toMatchObject({ id: os.id, ...full });
        expect(reopened.find(ordinary.id)).toMatchObject(restricted);
        const disk = await new Store(dir).readAgents();
        expect(disk.find((a) => a.id === os.id)).toMatchObject(full);
    });

    for (const setting of ['permissions', 'accessScope', 'autoApprove', 'manageTabs', 'drivePages'] as const) {
        it(`a stale API request cannot restrict Genie's ${setting}`, async () => {
            const r = await load(); const os = r.osAgent()!;
            if (setting === 'permissions') await r.setPermissions(os.id, 'ask');
            if (setting === 'accessScope') await r.setAccessScope(os.id, 'none');
            if (setting === 'autoApprove') await r.setAutoApprove(os.id, false);
            if (setting === 'manageTabs') await r.setManageTabs(os.id, false);
            if (setting === 'drivePages') await r.setDrivePages(os.id, false);
            expect(r.osAgent()).toMatchObject(full);
            expect((await load()).osAgent()).toMatchObject(full);
        });
    }

    it('remains reachable from every workspace even when workspace and incoming agent scopes are none', () => {
        const os = { ...agentRecord({ id: mintAgentId(), workspaceId: OS_WORKSPACE, provider: 'claude', name: 'genie' }), accessScope: 'none' as const };
        const ordinary = agentRecord({ id: mintAgentId(), workspaceId: 'project', provider: 'codex', name: 'atlas', accessScope: 'none' });
        const closed = () => ({ scope: 'none' as const });
        expect(reachable(ordinary, os, closed)).toBe(true);
        expect(reachable(os, ordinary, closed)).toBe(true);
        const impersonator = { ...os, workspaceId: 'project', id: mintAgentId() };
        expect(reachable(ordinary, impersonator, closed)).toBe(false);
        expect(reachable(impersonator, ordinary, closed)).toBe(false);
    });
});

describe('the built-in Genie settings page', () => {
    const facts = { fidelity: 'declared' as const, provider: 'claude', ops: true, model: true, tools: true, autonomous: true, manageTabs: true, drivePages: true, issueWatch: true, persona: true, skills: true };
    it('has no Permissions section while a normal agent with the same name keeps its controls', () => {
        expect(settingsSections({ ...facts, name: 'genie', workspaceId: OS_WORKSPACE }).map((s) => s.id)).not.toContain('permissions');
        expect(settingsSections({ ...facts, name: 'genie', workspaceId: 'project' }).find((s) => s.id === 'permissions')?.controls).toEqual(['tools', 'access', 'autonomous', 'manage-tabs', 'drive-pages']);
    });

    it('renders its fixed policy without permission controls; even a stale Permissions tab lands on General', () => {
        const ops = { permissions: 'all', accessScope: 'all', autoApprove: true, manageTabs: true, drivePages: true,
            onSetPermissions: () => {}, onSetAccessScope: () => {}, onSetAutoApprove: () => {}, onSetManageTabs: () => {}, onSetDrivePages: () => {},
            onSetMode: () => {}, onSwitchDriver: () => {}, onRestart: () => {}, onDelete: () => {},
        } as unknown as AgentOpsProps;
        const render = (workspaceId: string) => renderToStaticMarkup(<AgentView agent={{ id: 'os-id', name: 'genie', workspaceId, provider: 'claude', fidelity: 'declared', cwd: '/work' }} session={null} rows={[]} tab="settings" settingsSection="permissions" lanes={null} at={null} selectedId={null} turns={0} cost={null} onNavigate={() => {}} onSelect={() => {}} ops={ops} />);
        const os = render(OS_WORKSPACE);
        expect(os).toContain('Genie has full permissions');
        expect(os).not.toMatch(/data-permissions=|data-auto-approve=|data-manage-tabs=|data-drive-pages=|data-access-scope=/);
        const ordinary = render('project');
        expect(ordinary).toContain('data-permissions="all"');
        expect(ordinary).not.toContain('Genie has full permissions');
    });
});
