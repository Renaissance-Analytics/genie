import { mkdtemp, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AGENT_SCOPED_METHODS, capabilityOf } from '../src/core/remote-protocol.js';
import type { LiveSession } from '../src/core/roster.js';
import { Registry } from '../src/main/registry.js';
import { Store } from '../src/main/store.js';
import { AgentView } from '../src/renderer/components/AgentView.js';

/**
 * "MAY DRIVE PAGES" — A PER-AGENT SWITCH (browser rebuild step 7; the owner, FTQ q_82269ca5, 2026-10-21: "add its own
 * switch"). Agents read, fill, click and submit Genie site pages through fancy's navigation bridge; the workspace's
 * default agent may always; any other agent only when this switch is on, in its Settings beside "May manage workspace
 * tabs". Submits and destructive clicks always ask the person, whoever the agent is. This row is the switch, kept and
 * carried to every window; the page tool that reads it is the next row.
 */

const src = (p: string) => readFileSync(p, 'utf8').split(/\r?\n/).map((l) => l.replace(/^\s*\/\/.*$/, '')).join('\n');

describe('the switch is the agent’s, and it is kept', () => {
    let dir: string;
    beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'genie2-drive-pages-')); });
    afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

    it('off by default; set, and kept across a reload — and independent of the tabs switch', async () => {
        const registry = new Registry(new Store(dir));
        await registry.load({ name: 'host', healthy: true });
        await registry.addWorkspace({ id: 'tynn', path: '/w/tynn' });
        const a = await registry.register({ workspaceId: 'tynn', provider: 'claude', name: 'atlas' });
        expect((a as { drivePages?: boolean }).drivePages ?? false).toBe(false);
        const set = (registry as unknown as { setDrivePages(id: string, on: boolean): Promise<unknown> }).setDrivePages;
        expect(typeof set).toBe('function');
        expect(await set.call(registry, a.id, true)).toMatchObject({ drivePages: true });
        const again = new Registry(new Store(dir));
        await again.load({ name: 'host', healthy: true });
        expect(again.find(a.id)).toMatchObject({ drivePages: true });
        expect(again.find(a.id)?.manageTabs ?? false).toBe(false);
    });
});

describe('the Settings tab shows it, after "May manage workspace tabs"', () => {
    const session = { running: true, turnState: 'idle', startedAt: 0, pendingApproval: null, failure: null, contextUsed: null, contextSize: null, plan: null } as unknown as LiveSession;
    const AGENT = { id: 'kai', name: 'kai', provider: 'claude', fidelity: 'declared' as const, cwd: '/w' };
    const opsFor = (drivePages: boolean) => ({ mode: 'automated', accessScope: 'self', autoApprove: false, onMode: () => {}, onSetAutoApprove: () => {}, manageTabs: false, onSetManageTabs: () => {}, drivePages, onSetDrivePages: () => {}, onRestart: () => {}, onDelete: () => {} }) as never;
    const render = (ops: unknown) => renderToStaticMarkup(<AgentView agent={AGENT} session={session} rows={[]} tab="settings" lanes={null} at={null} selectedId={null} turns={1} cost={null} onNavigate={() => {}} onSelect={() => {}} now={() => 0} ops={ops as never} />);

    it('on and off, in the owner’s words, after the tabs switch; it says submits always ask', () => {
        const on = render(opsFor(true));
        expect(on).toMatch(/data-drive-pages="on"[^>]*>(?:(?!<\/span>)[\s\S])*?role="switch" aria-checked="true"/);
        expect(render(opsFor(false))).toMatch(/data-drive-pages="off"[^>]*>(?:(?!<\/span>)[\s\S])*?role="switch" aria-checked="false"/);
        expect(on).toContain('May drive pages');
        expect(on).toMatch(/always asks you/);
        expect(on.indexOf('data-drive-pages')).toBeGreaterThan(on.indexOf('data-manage-tabs'));
    });

    it('CONTROL: a window that cannot set it shows no switch', () => {
        const ops = { mode: 'automated', accessScope: 'self', onMode: () => {}, onRestart: () => {}, onDelete: () => {} };
        expect(render(ops)).not.toContain('data-drive-pages');
    });
});

describe('the wiring: every window can set it, a remote one too, scoped like the agent’s other switches', () => {
    it('remote: a write, scoped to the agent (a guest of another workspace cannot reach it)', () => {
        expect(capabilityOf('agents.setDrivePages' as never)).toBe('write');
        expect(AGENT_SCOPED_METHODS).toContain('agents.setDrivePages');
    });

    it('main has its IPC and the detail carries it; preload, the host API, the remote bridge and the App pass it on', () => {
        const main = src('src/main/main.ts');
        expect(main).toMatch(/ipcMain\.handle\('genie:agent-set-drive-pages'/);
        expect(main).toMatch(/drivePages: record\.drivePages === true/);
        expect(src('src/main/preload.ts')).toMatch(/setDrivePages: \(agentId, on\) => ipcRenderer\.invoke\('genie:agent-set-drive-pages', agentId, on\)/);
        expect(src('src/main/host-api.ts')).toMatch(/case 'agents\.setDrivePages':\s*return deps\.agentOps\.setDrivePages\(str\(args\[0\]\), args\[1\] === true\);/);
        expect(src('src/renderer/remote-bridge.ts')).toMatch(/setDrivePages: \(agentId, on\) => answer\('agents\.setDrivePages', agentId, on\)/);
        const app = src('src/renderer/App.tsx');
        expect(app).toMatch(/drivePages: detail\?\.agent\.drivePages === true/);
        expect(app).toMatch(/onSetDrivePages: \(on\) =>/);
    });
});
