import { claudeArgs, type ClaudeDriverOptions } from '@particle-academy/prism-acp';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { providerProtocol } from '../src/core/genie-protocol.js';
import { agentRecord, mintAgentId, type AgentPermissions, type AgentRecord } from '../src/core/identity.js';
import { setPermissions, type AgentOpsPorts } from '../src/main/agent-ops-host.js';
import { buildHostApi, type HostApiDeps } from '../src/main/host-api.js';
import { claudeOptionsFor, raisesApprovals } from '../src/main/session-host.js';
import { AgentView, type AgentOpsProps } from '../src/renderer/components/AgentView.js';

/**
 * A CLAUDE AGENT THAT ASKS BEFORE SHELL COMMANDS (the owner: a Claude agent should be able to ASK the person before
 * running shell commands, approved inline like Codex). Until now a Claude agent had two settings — all tools, or edits
 * only (shell refused) — because its session could not ask a person mid-turn. prism-acp 0.10.0 adds
 * `ClaudeDriverOptions.permissionPrompts`: each matching tool call raises `onRequestPermission` (the same request
 * Codex raises; allow_once / reject_once) and runs ONLY on an explicit allow once. Genie already wires that event into
 * its approval flow for every driver, so the third setting is `ask` → `bypassPermissions` PLUS prompts for `Bash`:
 * every other tool (Genie's MCP tools included) keeps running, and only a shell command waits for the person. `all`
 * and `edits` carry NO prompts — the absence is counted, with `ask` from the same function as its positive control.
 */
const record = (permissions?: AgentPermissions): AgentRecord =>
    ({ ...agentRecord({ id: mintAgentId(), workspaceId: 'tynn', provider: 'claude', name: 'moic' }), ...(permissions ? { permissions } : {}) });
const promptKeys = (o: object) => Object.keys(o).filter((k) => k === 'permissionPrompts').length;

describe('the options Claude starts with', () => {
    it('ask → bypassPermissions AND prompts for Bash only', () => {
        const o = claudeOptionsFor(record('ask'), '/w/tynn', null);
        expect(o.permissionMode).toBe('bypassPermissions');
        expect(promptKeys(o)).toBe(1);
        // Both shell tools: Claude Code also has PowerShell on Windows, and gating Bash alone would let it through unasked.
        expect(o.permissionPrompts).toEqual({ tools: ['Bash', 'PowerShell'] });
    });

    it('edits → acceptEdits and no prompts; all and absent → bypassPermissions and no prompts (positive control: ask has one)', () => {
        const edits = claudeOptionsFor(record('edits'), '/w/tynn', null);
        expect(edits.permissionMode).toBe('acceptEdits');
        expect(promptKeys(edits)).toBe(0);
        expect(Object.hasOwn(edits, 'permissionPrompts')).toBe(false);
        for (const p of ['all', undefined] as const) {
            const o = claudeOptionsFor(record(p), '/w/tynn', null);
            expect(o.permissionMode).toBe('bypassPermissions');
            expect(promptKeys(o)).toBe(0);
            expect(Object.hasOwn(o, 'permissionPrompts')).toBe(false);
        }
        expect(promptKeys(claudeOptionsFor(record('ask'), '/w/tynn', null))).toBe(1);
    });

    it('is a ClaudeDriver option prism-acp accepts, and its argv carries --settings only when the driver supplies the file', () => {
        // A typed assignment: if 0.10.0's ClaudeDriverOptions did not take permissionPrompts, this would not compile.
        const typed: ClaudeDriverOptions = claudeOptionsFor(record('ask'), '/w/tynn', null);
        const without = claudeArgs(typed);
        expect(without).not.toContain('--settings');
        expect(without[without.indexOf('--permission-mode') + 1]).toBe('bypassPermissions');
        const withFile = claudeArgs(typed, undefined, '/tmp/s.json');
        expect(withFile.filter((a) => a === '--settings')).toHaveLength(1);
        // On Windows prism-acp quotes the path for the shell; either way it is the path given.
        expect(withFile[withFile.indexOf('--settings') + 1]).toContain('/tmp/s.json');
    });
});

describe('whether the agent raises approvals', () => {
    it('a Claude agent set to ask does; one set to all, or with no setting, does not; codex does', () => {
        expect(raisesApprovals('claude', 'ask')).toBe(true);
        expect(raisesApprovals('claude', 'all')).toBe(false);
        expect(raisesApprovals('claude', 'edits')).toBe(false);
        expect(raisesApprovals('claude')).toBe(false);
        expect(raisesApprovals('codex')).toBe(true);
        expect(raisesApprovals('kimi', 'ask')).toBeNull();
    });
});

describe('the operation', () => {
    const ports = (rec: AgentRecord): AgentOpsPorts => {
        let current = rec;
        return { registry: { find: (id: string) => (id === current.id ? current : null), setPermissions: async (_id: unknown, permissions: AgentPermissions) => { current = { ...current, permissions }; return current; } } } as unknown as AgentOpsPorts;
    };
    const rec = (provider: string) => ({ id: 'agent_a', workspaceId: 'tynn', provider, name: 'atlas', mode: 'manual', accessScope: 'self' }) as unknown as AgentRecord;

    it('a Claude agent takes ask; a Codex agent is still refused with the reason', async () => {
        expect(await setPermissions(ports(rec('claude')), 'agent_a', 'ask')).toMatchObject({ ok: true, record: { permissions: 'ask' } });
        const codex = await setPermissions(ports(rec('codex')), 'agent_a', 'ask');
        expect(codex).toMatchObject({ ok: false });
        expect((codex as { reason: string }).reason).toMatch(/Codex asks in the chat/);
    });

    it('the remote method passes ask and edits through; anything else is all', async () => {
        const seen: string[] = [];
        const api = buildHostApi({ agentOps: { setPermissions: async (_id: string, p: AgentPermissions) => { seen.push(p); return { ok: true }; } } } as unknown as HostApiDeps);
        for (const arg of ['ask', 'edits', 'all', 'bogus']) await api.invoke('agents.setPermissions', ['agent_a', arg]);
        expect(seen).toEqual(['ask', 'edits', 'all', 'all']);
    });
});

describe('the control', () => {
    const ops = (over: Partial<AgentOpsProps> = {}): AgentOpsProps => ({
        deletePreview: null, diagnosis: null, lastOutcome: null, budgetUsd: null, mode: 'manual', accessScope: 'self', permissions: 'all',
        onRestart: () => {}, onSwitchDriver: () => {}, onDiagnose: () => {}, onPreviewDelete: () => {}, onConfirmDelete: () => {}, onCancelDelete: () => {}, onSetBudget: () => {},
        onSetMode: () => {}, onSetAccessScope: () => {}, onSetPermissions: () => {},
        ...over,
    });
    const render = (o: AgentOpsProps) => renderToStaticMarkup(
        <AgentView agent={{ id: 'agent_a', name: 'atlas', provider: 'claude', fidelity: 'declared', cwd: '/w/tynn' }} session={null} rows={[]} tab="settings" settingsSection="permissions" lanes={null} at={null} selectedId={null} turns={0} cost={null} onNavigate={() => {}} onSelect={() => {}} ops={o} />,
    );

    it('offers ask between all tools and edits only, selected when the agent is set so (positive control: not selected when all)', () => {
        const html = render(ops({ permissions: 'ask' }));
        expect(html).toContain('data-permissions="ask"');
        expect(html).toMatch(/<option value="ask" selected=""[^>]*>ask me before shell commands<\/option>/);
        expect(html).toMatch(/<option value="all"[^>]*>all tools<\/option><option value="ask"[^>]*>ask me before shell commands<\/option><option value="edits"/);
        expect(render(ops({ permissions: 'all' }))).toMatch(/<option value="ask">ask me before shell commands<\/option>/);
    });
});

describe('what the agent is told', () => {
    it('the Claude protocol names the three settings and says a shell command waits for the person', () => {
        const text = providerProtocol('claude');
        expect(text).toMatch(/all tools[\s\S]*ask before shell commands[\s\S]*edits only/);
        expect(text).toMatch(/waits for the person's approval in the chat; wait for it, do not retry it while it waits/);
        expect(text).not.toMatch(/cannot ask the person/);
    });
});
