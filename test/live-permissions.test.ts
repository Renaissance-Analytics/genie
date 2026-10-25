import { claudeArgs } from '@particle-academy/prism-acp';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { applyOutcome } from '../src/core/agent-ops.js';
import { agentRecord, mintAgentId, type AgentPermissions, type AgentRecord } from '../src/core/identity.js';
import type { ProcessTree } from '../src/core/process-tree.js';
import { AgentSession, type DriverEvents, type PermissionRequestLike, type SessionDriverFactory } from '../src/core/session.js';
import { openDurableStore } from '../src/core/thread-store.js';
import { setPermissions, type AgentOpsPorts } from '../src/main/agent-ops-host.js';
import { SessionHost, claudeOptionsFor, permissionDecisionFor, type DriverFor } from '../src/main/session-host.js';

/**
 * A CLAUDE AGENT'S TOOL SETTING IS LIVE — NO RESTART (genie#1188; the owner, 2026-10-25: "I should not have to restart
 * an agent when I change its permissions"). The setting was read ONCE, on the CLI's command line
 * (`--permission-mode`), so a change restarted the agent on the same conversation. prism-acp has no live
 * permission-mode switch, so the setting moves off the command line: every Claude agent starts the SAME way — bypass,
 * with both shell tools routed through prism-acp's permission hook — and the hook's question is answered from the
 * agent's setting AT THAT MOMENT: all tools → allowed at once, nobody asked; ask → parked for the person, as before;
 * edits only → refused. The hook mechanism is the one `ask` has used in production since prism-acp 0.10.
 */

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const noProcessTree: ProcessTree = { snapshot: () => [], killTree: (pids) => ({ killed: pids.length, refused: false }) };
const record = (permissions?: AgentPermissions): AgentRecord =>
    ({ ...agentRecord({ id: mintAgentId(), workspaceId: 'tynn', provider: 'claude', name: 'moic' }), ...(permissions ? { permissions } : {}) });

/** What prism-acp's hook sends for a shell call: allow once / reject once, by ACP kind. */
const shellAsk: PermissionRequestLike = {
    toolCall: { title: 'git push --force', name: 'Bash', rawInput: { command: 'git push --force' } },
    options: [
        { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'reject_once', name: 'Reject', kind: 'reject_once' },
    ],
};

function session(decide: () => AgentPermissions) {
    const dir = mkdtempSync(join(tmpdir(), 'genie2-live-perm-'));
    dirs.push(dir);
    let events: DriverEvents = {};
    const factory: SessionDriverFactory = (options) => {
        events = options.events;
        return { start: () => {}, prompt: () => {}, kill: () => {}, get running() { return true; }, get cliSessionId() { return null; } };
    };
    const s = new AgentSession({ agentId: mintAgentId(), cwd: dir, store: openDurableStore(dir), driverFactory: factory, processTree: noProcessTree, permissionDecision: () => permissionDecisionFor(decide()) });
    s.start();
    return { s, ask: () => events.onRequestPermission!(shellAsk) };
}

describe('every Claude agent starts the same way, whatever its setting', () => {
    it('bypass + both shell tools through the hook, for all, ask, edits and no setting — the command line carries no setting', () => {
        const argvs = (['all', 'ask', 'edits', undefined] as const).map((p) => {
            const o = claudeOptionsFor(record(p), '/w/tynn', null);
            expect(o.permissionMode, String(p)).toBe('bypassPermissions');
            expect(o.permissionPrompts, String(p)).toEqual({ tools: ['Bash', 'PowerShell'] });
            return claudeArgs(o).join(' ');
        });
        // The same argv for all four: nothing about the setting is fixed when the process starts.
        expect(new Set(argvs).size).toBe(1);
    });
});

describe("the hook's question is answered by the setting AT THAT MOMENT", () => {
    it('all → allowed at once and nobody is asked; then edits → refused; then ask → parked — one session, no restart', async () => {
        let setting: AgentPermissions = 'all';
        const { s, ask } = session(() => setting);

        expect(await ask()).toEqual({ outcome: 'selected', optionId: 'allow_once' });
        expect(s.pendingApproval).toBeNull();

        setting = 'edits';
        expect(await ask()).toEqual({ outcome: 'selected', optionId: 'reject_once' });
        expect(s.pendingApproval).toBeNull();

        setting = 'ask';
        const parked = ask();
        expect(s.pendingApproval).toMatchObject({ question: 'git push --force' });
        s.answerApproval('allow_once');
        expect(await parked).toEqual({ outcome: 'selected', optionId: 'allow_once' });
    });

    it('allow is answered with the option whose ACP KIND is allow_once — never guessed from a label', async () => {
        const dir =mkdtempSync(join(tmpdir(), 'genie2-live-perm-'));
        dirs.push(dir);
        let events: DriverEvents = {};
        const s = new AgentSession({ agentId: mintAgentId(), cwd: dir, store: openDurableStore(dir), processTree: noProcessTree, permissionDecision: () => 'allow', driverFactory: (o) => { events = o.events; return { start: () => {}, prompt: () => {}, kill: () => {}, get running() { return true; }, get cliSessionId() { return null; } }; } });
        s.start();
        const tricky: PermissionRequestLike = { toolCall: { title: 'rm -rf build' }, options: [{ optionId: 'x1', name: 'Allow (actually rejects)', kind: 'reject_once' }, { optionId: 'x2', name: 'Go', kind: 'allow_once' }] };
        expect(await events.onRequestPermission!(tricky)).toEqual({ outcome: 'selected', optionId: 'x2' });
        // No allow_once offered: refused, never "allowed" by some other option.
        const none: PermissionRequestLike = { toolCall: { title: 'rm -rf build' }, options: [{ optionId: 'x1', name: 'Reject', kind: 'reject_once' }] };
        expect(await events.onRequestPermission!(none)).toEqual({ outcome: 'selected', optionId: 'x1' });
    });

    it('the decision for each setting', () => {
        expect(permissionDecisionFor('all')).toBe('allow');
        expect(permissionDecisionFor(undefined)).toBe('allow');
        expect(permissionDecisionFor('ask')).toBe('ask');
        expect(permissionDecisionFor('edits')).toBe('deny');
    });
});

describe('the real SessionHost reads the CURRENT record at each shell call (main.ts wires the registry in)', () => {
    let events: DriverEvents = {};
    const driverFor: DriverFor = (r) => (r.provider === 'claude' || r.provider === 'codex'
        ? (options) => { events = options.events; return { start: () => {}, prompt: () => {}, kill: () => {}, get cliSessionId() { return null; } }; }
        : null);

    it('one running session: all → allowed; the record changed to edits → refused; to ask → parked, then settled by the host', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'genie2-live-perm-host-'));
        dirs.push(dir);
        let current = record('all');
        const host = new SessionHost({ userData: dir, driverFor, processTree: noProcessTree, currentRecord: (id) => (id === current.id ? current : null) });
        try {
            expect(host.start(current, dir)).toEqual({ ok: true });
            expect(await events.onRequestPermission!(shellAsk)).toEqual({ outcome: 'selected', optionId: 'allow_once' });
            current = { ...current, permissions: 'edits' };
            expect(await events.onRequestPermission!(shellAsk)).toEqual({ outcome: 'selected', optionId: 'reject_once' });
            current = { ...current, permissions: 'ask' };
            const parked = events.onRequestPermission!(shellAsk);
            expect(host.probe(current.id)?.pendingApproval).toMatchObject({ question: 'git push --force' });
            expect(host.settleParked(current.id, 'allow')).toBe(true);
            expect(await parked).toEqual({ outcome: 'selected', optionId: 'allow_once' });
            expect(host.settleParked(current.id, 'allow')).toBe(false);
        } finally {
            host.stopAll();
        }
    });

    it('CONTROL: a Codex agent is never answered by a decision — its requests always reach the person', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'genie2-live-perm-host-'));
        dirs.push(dir);
        const codex = { ...agentRecord({ id: mintAgentId(), workspaceId: 'tynn', provider: 'codex', name: 'cx' }), permissions: 'all' as const };
        const host = new SessionHost({ userData: dir, driverFor, processTree: noProcessTree, currentRecord: () => codex });
        try {
            host.start(codex, dir);
            void events.onRequestPermission!(shellAsk);
            expect(host.probe(codex.id)?.pendingApproval).toMatchObject({ question: 'git push --force' });
        } finally {
            host.stopAll();
        }
    });
});

describe('changing the setting restarts nothing', () => {
    it('setPermissions saves it and says it is live — no restart is asked for, whatever the session is doing', async () => {
        let current = record('all');
        let applyCalls = 0;
        const ports = {
            registry: { find: (id: string) => (id === current.id ? current : null), setPermissions: async (_id: unknown, permissions: AgentPermissions) => { current = { ...current, permissions }; return current; } },
            applyOnStart: () => { applyCalls += 1; return { when: 'now' as const }; },
        } as unknown as AgentOpsPorts;
        expect(await setPermissions(ports, current.id, 'edits')).toMatchObject({ ok: true, record: { permissions: 'edits' }, apply: { when: 'live' } });
        expect(applyCalls).toBe(0);
        expect(applyOutcome('moic', 'edits only', { when: 'live' })).toBe('edits only — applies from moic’s next shell command, no restart');
    });

    it('a shell command parked on the person is answered by the new setting: all → allowed, edits → refused; ask leaves it parked', async () => {
        for (const [to, settled] of [['all', 'allow'], ['edits', 'deny'], ['ask', null]] as const) {
            let current = record('ask');
            const settledWith: string[] = [];
            const ports = {
                registry: { find: (id: string) => (id === current.id ? current : null), setPermissions: async (_id: unknown, permissions: AgentPermissions) => { current = { ...current, permissions }; return current; } },
                host: { settleParked: (_id: string, decision: 'allow' | 'deny') => { settledWith.push(decision); return true; } },
            } as unknown as AgentOpsPorts;
            await setPermissions(ports, current.id, to);
            expect(settledWith, to).toEqual(settled ? [settled] : []);
        }
    });
});
