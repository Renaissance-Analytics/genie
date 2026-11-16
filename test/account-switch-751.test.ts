import { beforeEach, describe, expect, it } from 'vitest';
import type { AccountRecord } from '../src/core/accounts.js';
import type { AcpProvider } from '../src/core/engine.js';
import { agentRecord, mintAgentId, type AgentId, type AgentRecord } from '../src/core/identity.js';
import type { StopVerdict } from '../src/core/session.js';
import { switchActiveAccount, type AccountSwitchPorts } from '../src/main/account-switch-host.js';

/**
 * SWITCHING A PROVIDER'S ACTIVE ACCOUNT MOVES EVERY AGENT STRAIGHT AWAY (Tynn #751; the owner: "move straight away").
 * The active account is set, every running agent of that provider is stopped cleanly and resumed on the new account with
 * a carry-over note naming the switch; what was queued for the agent stays owed and is delivered after the resume.
 * Fixtures use no real person.
 */
const A = `account_${'a'.repeat(32)}`;
const B = `account_${'b'.repeat(32)}`;
const CODEX = `account_${'c'.repeat(32)}`;
const account = (provider: AcpProvider, id: string, label: string, legacy = false): AccountRecord => ({
    id, provider, legacy, labelEdited: true, label, home: `/genie/accounts/${provider}/${label}`,
    identity: { name: null, email: null, plan: null }, createdAt: '2026-11-16T00:00:00Z',
});
const book = new Map<string, AccountRecord>([
    ['account_legacy_claude', account('claude', 'account_legacy_claude', 'Account 1', true)],
    [A, account('claude', A, 'Work')], [B, account('claude', B, 'Spare')], [CODEX, account('codex', CODEX, 'Codex spare')],
]);
const agent = (name: string, provider: AcpProvider = 'claude'): AgentRecord => agentRecord({ id: mintAgentId(), workspaceId: 'ws', provider, name });

let log: string[];
let active: Record<string, string>;
let running: AgentId[];
let agents: AgentRecord[];
let refuseStart: Set<string>;
let endedVerdict: (id: AgentId) => StopVerdict | null;
const nameOf = (id: string) => agents.find(a => a.id === id)?.name ?? id;

function ports(): AccountSwitchPorts {
    return {
        accounts: {
            get: id => book.get(id) ?? null,
            activeFor: provider => book.get(active[provider] ?? `account_legacy_${provider}`)!,
            setActive: async (provider, id) => { log.push(`setActive ${provider} ${id}`); active[provider] = id; },
        },
        registry: { find: id => agents.find(a => a.id === id) ?? null },
        host: {
            startedIds: () => [...running],
            stop: id => { log.push(`stop ${nameOf(id)}`); },
            ended: async id => { log.push(`ended ${nameOf(id)}`); return endedVerdict(id); },
            start: record => { log.push(`start ${record.name}`); return refuseStart.has(record.name) ? { ok: false, reason: `${record.name} has no folder` } : { ok: true }; },
            deliverOwed: async (id, then) => { log.push(`deliverOwed ${nameOf(id)}${then ? ` ${then.by}: ${then.text}` : ''}`); return 0; },
        },
        cwdFor: () => '/ws',
    };
}

beforeEach(() => {
    log = []; active = { claude: A }; refuseStart = new Set();
    endedVerdict = () => ({ verified: true, ended: 1 });
    agents = [agent('atlas'), agent('wren'), agent('kai'), agent('idle'), agent('codex-agent', 'codex')];
    running = agents.filter(a => a.name !== 'idle').map(a => a.id);
});

describe('switching moves every running agent of the provider at once', () => {
    it('sets the active account first, then stops and resumes each running agent of THAT provider only', async () => {
        const answer = await switchActiveAccount(ports(), 'claude', B);
        expect(answer).toMatchObject({ ok: true, failed: [] });
        expect(log[0]).toBe(`setActive claude ${B}`);
        for (const name of ['atlas', 'wren', 'kai']) {
            const mine = log.filter(l => new RegExp(`^(stop|ended|start|deliverOwed) ${name}\\b`).test(l)).map(l => l.split(' ')[0]);
            expect(mine).toEqual(['stop', 'ended', 'start', 'deliverOwed']);
        }
        expect(log.some(l => /codex-agent|idle/.test(l))).toBe(false);
        expect((answer as { moved: AgentId[] }).moved.map(nameOf).sort()).toEqual(['atlas', 'kai', 'wren']);
    });

    it('each agent resumes with a carry-over note that names the switch, after what it was owed', async () => {
        await switchActiveAccount(ports(), 'claude', B);
        const delivered = log.filter(l => l.startsWith('deliverOwed atlas'));
        expect(delivered).toHaveLength(1);
        expect(delivered[0]).toMatch(/genie:/);
        expect(delivered[0]).toContain('Work');
        expect(delivered[0]).toContain('Spare');
        expect(delivered[0]).toMatch(/switch/i);
    });

    it('switching to the account already active moves nobody', async () => {
        const answer = await switchActiveAccount(ports(), 'claude', A);
        expect(answer).toMatchObject({ ok: true, moved: [], failed: [] });
        expect(log).toEqual([]);
    });

    it('an agent that cannot start again is reported, the others still move, and nothing is delivered to it', async () => {
        refuseStart.add('wren');
        const answer = await switchActiveAccount(ports(), 'claude', B);
        expect(answer).toMatchObject({ ok: true, failed: [{ reason: expect.stringContaining('wren') }] });
        expect((answer as { moved: AgentId[] }).moved.map(nameOf).sort()).toEqual(['atlas', 'kai']);
        expect(log.some(l => l.startsWith('deliverOwed wren'))).toBe(false);
    });

    it('a previous run that did not end is not started again, and is reported', async () => {
        endedVerdict = id => nameOf(id) === 'kai' ? { verified: false, reason: 'a process is still running', survivors: [] } : { verified: true, ended: 1 };
        const answer = await switchActiveAccount(ports(), 'claude', B);
        expect(answer).toMatchObject({ ok: true, failed: [{ reason: expect.stringContaining('did not end') }] });
        expect(log).not.toContain('start kai');
    });
});

describe('a switch that cannot be made changes nothing', () => {
    it('an unknown account is refused before any agent is stopped', async () => {
        const answer = await switchActiveAccount(ports(), 'claude', `account_${'f'.repeat(32)}`);
        expect(answer).toMatchObject({ ok: false, reason: expect.stringMatching(/account/i) });
        expect(log).toEqual([]);
    });

    it('another provider’s account is refused before any agent is stopped', async () => {
        const answer = await switchActiveAccount(ports(), 'claude', CODEX);
        expect(answer).toMatchObject({ ok: false, reason: expect.stringMatching(/account/i) });
        expect(log).toEqual([]);
    });
});
