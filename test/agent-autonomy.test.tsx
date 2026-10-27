import { mkdtemp, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LiveSession } from '../src/core/roster.js';
import { ApprovalQueue } from '../src/main/approval-queue.js';
import { Registry } from '../src/main/registry.js';
import { Store } from '../src/main/store.js';
import { AgentView } from '../src/renderer/components/AgentView.js';

/**
 * AN AGENT CAN BE AUTONOMOUS (Tynn #801). The owner, 2026-10-17: "We are missing options too like the ability to let an
 * agent be autonomous and not need approval to setup services and processes, etc." A per-agent switch: its gated
 * actions — services add/use/detach/remove/exec, processes add/remove, sites update/remove, terminals create/write — run
 * without parking on the Deck, each one RECORDED so the person can see what it did. Every other agent is asked, as
 * before. Deleting data is not among them: Genie keeps an engine's data on every remove, by design.
 */
const caller = (agentId: string, agentName = agentId) => ({ agentId, agentName, workspaceId: 'tynn', workspacePath: '/w/tynn' }) as never;

describe('the approval gate', () => {
    it('an autonomous agent’s action is allowed AT ONCE, parks nothing, and is recorded', async () => {
        const q = new ApprovalQueue({ now: () => 1000, autoApproved: (c) => c.agentId === 'a1' });
        await expect(q.gate(caller('a1', 'atlas'), 'services.add', 'Postgres 17 (dedicated)')).resolves.toBe('allowed');
        expect(q.deckItems()).toEqual([]);
        expect(q.autoApproved()).toEqual([{ agentId: 'a1', agentName: 'atlas', action: 'services.add', detail: 'Postgres 17 (dedicated)', at: 1000 }]);
    });

    it('CONTROL: any other agent is still asked — the request parks as a blocking Deck item', async () => {
        const q = new ApprovalQueue({ now: () => 1000, autoApproved: (c) => c.agentId === 'a1' });
        let settled = false;
        void q.gate(caller('b2', 'wren'), 'processes.add', 'npm run queue').then(() => { settled = true; });
        await Promise.resolve();
        expect(settled).toBe(false);
        expect(q.deckItems()).toHaveLength(1);
        expect(q.autoApproved()).toEqual([]);
    });

    it('the record keeps the latest 50, newest last', async () => {
        let t = 0;
        const q = new ApprovalQueue({ now: () => ++t, autoApproved: () => true });
        for (let i = 0; i < 55; i++) await q.gate(caller('a1'), 'create', `terminal ${i}`);
        expect(q.autoApproved()).toHaveLength(50);
        expect(q.autoApproved().at(-1)?.detail).toBe('terminal 54');
    });

    it('compose gives the gate the agent’s own switch', () => {
        const compose = readFileSync('src/main/compose.ts', 'utf8');
        // genie#1294 added `granted` (the agent's permission switches) beside it; test/permission-switch-approvals.test.ts
        // checks both through the composed queue.
        expect(compose).toMatch(/new ApprovalQueue\(\{\s*now,\s*autoApproved: \(caller\) => \(input\.roster\?\.\(\) \?\? \[\]\)\.some\(\(a\) => a\.id === caller\.agentId && a\.autoApprove === true\),/);
    });
});

describe('the switch is the agent’s, and it is kept', () => {
    let dir: string;
    beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'genie2-autonomy-')); });
    afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

    it('off by default; set, and kept across a reload', async () => {
        const registry = new Registry(new Store(dir));
        await registry.load({ name: 'host', healthy: true });
        await registry.addWorkspace({ id: 'tynn', path: '/w/tynn' });
        const a = await registry.register({ workspaceId: 'tynn', provider: 'claude', name: 'atlas' });
        expect(a.autoApprove ?? false).toBe(false);
        expect(await registry.setAutoApprove(a.id, true)).toMatchObject({ autoApprove: true });
        const again = new Registry(new Store(dir));
        await again.load({ name: 'host', healthy: true });
        expect(again.find(a.id)).toMatchObject({ autoApprove: true });
    });
});

describe('the Settings tab shows it', () => {
    const session = { running: true, turnState: 'idle', startedAt: 0, pendingApproval: null, failure: null, contextUsed: null, contextSize: null, plan: null } as unknown as LiveSession;
    const AGENT = { id: 'kai', name: 'kai', provider: 'claude', fidelity: 'declared' as const, cwd: '/w' };
    const opsFor = (autoApprove: boolean) => ({ mode: 'automated', accessScope: 'self', autoApprove, onMode: () => {}, onSetAutoApprove: () => {}, onRestart: () => {}, onDelete: () => {} }) as never;
    const render = (ops: unknown) => renderToStaticMarkup(<AgentView agent={AGENT} session={session} rows={[]} tab="settings" settingsSection="permissions" lanes={null} at={null} selectedId={null} turns={1} cost={null} onNavigate={() => {}} onSelect={() => {}} now={() => 0} ops={ops as never} />);

    it('on and off, said plainly; no ops (a window that cannot set it) → no switch (CONTROL)', () => {
        // Fancy's Switch (2026-10-19): its state is the switch's own aria-checked, inside the marked span.
        expect(render(opsFor(true))).toMatch(/data-auto-approve="on"[^>]*>(?:(?!<\/span>)[\s\S])*?role="switch" aria-checked="true"/);
        expect(render(opsFor(false))).toMatch(/data-auto-approve="off"[^>]*>(?:(?!<\/span>)[\s\S])*?role="switch" aria-checked="false"/);
        expect(render(opsFor(false))).toContain('without asking');
        expect(render(undefined)).not.toContain('data-auto-approve');
    });
});
