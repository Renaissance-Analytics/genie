import { mkdtemp, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LiveSession } from '../src/core/roster.js';
import { SETTINGS } from '../src/core/settings.js';
import { Registry } from '../src/main/registry.js';
import { Store } from '../src/main/store.js';
import { AgentView } from '../src/renderer/components/AgentView.js';

/**
 * "MAY MANAGE WORKSPACE TABS" — A PER-AGENT SWITCH (beta.35 item 36, step 6; the owner, FTQ q_227d0bb6): the workspace's
 * default agent has the `workspaceTabs` tool; any other agent only when this switch is on, in its Settings beside
 * Autonomous. The workspace setting `agents_design_tabs` — which gated nothing — is retired. A change an agent makes
 * reaches every window at once (main pushes the workspace's settings; the window reloads them).
 */

const src = (p: string) => readFileSync(p, 'utf8').split(/\r?\n/).map((l) => l.replace(/\/\/.*$/, '')).join('\n');

describe('the switch is the agent’s, and it is kept', () => {
    let dir: string;
    beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'genie2-manage-tabs-')); });
    afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

    it('off by default; set, and kept across a reload', async () => {
        const registry = new Registry(new Store(dir));
        await registry.load({ name: 'host', healthy: true });
        await registry.addWorkspace({ id: 'tynn', path: '/w/tynn' });
        const a = await registry.register({ workspaceId: 'tynn', provider: 'claude', name: 'atlas' });
        expect(a.manageTabs ?? false).toBe(false);
        expect(await registry.setManageTabs(a.id, true)).toMatchObject({ manageTabs: true });
        const again = new Registry(new Store(dir));
        await again.load({ name: 'host', healthy: true });
        expect(again.find(a.id)).toMatchObject({ manageTabs: true });
    });
});

describe('the Settings tab shows it, beside Autonomous', () => {
    const session = { running: true, turnState: 'idle', startedAt: 0, pendingApproval: null, failure: null, contextUsed: null, contextSize: null, plan: null } as unknown as LiveSession;
    const AGENT = { id: 'kai', name: 'kai', provider: 'claude', fidelity: 'declared' as const, cwd: '/w' };
    const opsFor = (manageTabs: boolean) => ({ mode: 'automated', accessScope: 'self', autoApprove: false, onMode: () => {}, onSetAutoApprove: () => {}, manageTabs, onSetManageTabs: () => {}, onRestart: () => {}, onDelete: () => {} }) as never;
    const render = (ops: unknown) => renderToStaticMarkup(<AgentView agent={AGENT} session={session} rows={[]} tab="settings" settingsSection="permissions" lanes={null} at={null} selectedId={null} turns={1} cost={null} onNavigate={() => {}} onSelect={() => {}} now={() => 0} ops={ops as never} />);

    it('on and off, named in the owner’s words; after the Autonomous switch', () => {
        const on = render(opsFor(true));
        expect(on).toMatch(/data-manage-tabs="on"[^>]*>(?:(?!<\/span>)[\s\S])*?role="switch" aria-checked="true"/);
        expect(render(opsFor(false))).toMatch(/data-manage-tabs="off"[^>]*>(?:(?!<\/span>)[\s\S])*?role="switch" aria-checked="false"/);
        expect(on).toContain('May manage workspace tabs');
        expect(on.indexOf('data-auto-approve')).toBeGreaterThan(-1);
        expect(on.indexOf('data-manage-tabs')).toBeGreaterThan(on.indexOf('data-auto-approve'));
    });

    it('CONTROL: a window that cannot set it shows no switch', () => {
        const ops = { mode: 'automated', accessScope: 'self', onMode: () => {}, onRestart: () => {}, onDelete: () => {} };
        expect(render(ops)).not.toContain('data-manage-tabs');
    });
});

describe('the workspace setting that gated nothing is gone', () => {
    it('agents_design_tabs is not a setting', () => {
        expect(SETTINGS.some((s) => s.key === 'agents_design_tabs')).toBe(false);
    });
});

describe('the wiring', () => {
    it('main: the tool is registered with the agent’s switch read from the roster; the switch has its IPC', () => {
        const main = src('src/main/main.ts');
        expect(main).toMatch(/ipcMain\.handle\('genie:agent-set-manage-tabs'/);
        expect(main).toMatch(/manageTabs: record\.manageTabs === true/);
    });

    it('a workspace setting changed in main reaches the windows (the tabs an agent made show at once)', () => {
        const main = src('src/main/main.ts');
        expect(main).toMatch(/settings\.onChange\(\(_key, _value, workspaceId\) => \{\s*if \(workspaceId\) broadcast\('genie:workspace-settings-changed', workspaceId\);/);
        const preload = src('src/main/preload.ts');
        expect(preload).toMatch(/onSettingsChanged: \(listener\) =>/);
        const app = src('src/renderer/App.tsx');
        expect(app).toMatch(/onSettingsChanged\?\.\(\(changed\) => \{ if \(changed === workspaceId\) reloadWsSettings\(resolvedBridge, workspaceId\); \}\)/);
    });
});
