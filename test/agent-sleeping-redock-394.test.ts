import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { agentRecord, mintAgentId, type AgentRecord } from '../src/core/identity.js';
import { agentRowFor } from '../src/core/roster.js';
import type { DriverEvents, SessionDriverFactory } from '../src/core/session.js';
import { SessionHost, type DriverFor } from '../src/main/session-host.js';

let dir: string;
const hosts: SessionHost[] = [];
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'genie2-sleep-redock-394-')); });
afterEach(async () => {
    vi.useRealTimers();
    for (const host of hosts.splice(0)) { host.stopAll(); await host.settled(); }
    await rm(dir, { recursive: true, force: true });
});
function setup(options: { failFirst?: boolean; redockAt?: string; provider?: 'claude' | 'codex' } = {}) {
    let events: DriverEvents = {};
    let failures = options.failFirst ? 1 : 0;
    const prompts: string[] = [], cleared: unknown[][] = [];
    const driverFor: DriverFor = () => ((o: { events: DriverEvents }) => {
        events = o.events;
        return { start: () => {}, prompt: (content: unknown) => {
            if (failures > 0) { failures--; throw new Error('provider refused'); }
            prompts.push(typeof content === 'string' ? content : JSON.stringify(content));
        }, kill: () => {}, get running() { return true; }, cliSessionId: null };
    }) as SessionDriverFactory;
    const host = new SessionHost({ userData: dir, driverFor, processTree: { snapshot: () => [], killTree: () => ({ killed: 0, refused: false }) }, onRedockSent: (...args: unknown[]) => cleared.push(args) } as never);
    hosts.push(host);
    const record = { ...agentRecord({ id: mintAgentId(), name: 'atlas', workspaceId: 'awake', provider: options.provider ?? 'claude' }), ...(options.redockAt ? { redockAt: options.redockAt } : {}) } as AgentRecord;
    expect(host.start(record, dir)).toEqual({ ok: true });
    return { host, record, prompts, cleared, end: () => events.onTurnEnd?.({ stopReason: 'end_turn' } as never) };
}

describe('story 394: Sleeping is an announced display state, never a work gate', () => {
    it('goes Cooling → Idle → Sleeping, pushes the boundary, and accepts mail immediately', () => {
        vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] }); vi.setSystemTime(1_800_000_000_000);
        const { host, record, end, prompts } = setup();
        const row = () => agentRowFor(record, host.probe(record.id), Date.now);
        expect(host.prompt(record.id, 'First turn', 'you')).toBe(true); end();
        expect(row().state).toBe('cooling');
        vi.advanceTimersByTime(15_000); expect(row().state).toBe('idle');
        const seen: string[] = []; host.subscribe(() => seen.push(row().state));
        vi.advanceTimersByTime(299_999); expect(row().state).toBe('idle');
        vi.advanceTimersByTime(1); expect(row().state).toBe('sleeping');
        expect(seen).toContain('sleeping');
        expect(host.prompt(record.id, 'AgentInbox has mail', 'peer')).toBe(true);
        expect(row().state).toBe('working');
        expect(prompts.at(-1)).toBe('AgentInbox has mail');
    });
});
describe('story 394: first accepted turn after redock', () => {
    it.each(['claude', 'codex'] as const)('%s receives a staleness and Tynn/repo reorientation notice before its first work only', async (provider) => {
        const { host, record, prompts, end, cleared } = setup({ redockAt: '2026-11-06T20:00:00.000Z', provider });
        expect(host.prompt(record.id, 'Continue the task', 'you')).toBe(true);
        expect(prompts[0]).toMatch(/hibernat|redock/i);
        expect(prompts[0]).toMatch(/stale|changed/i);
        expect(prompts[0]).toMatch(/git|repo/i);
        expect(prompts[0]).toContain('Tynn');
        expect(prompts[0]!.endsWith('Continue the task')).toBe(true);
        expect(cleared).toEqual([[record.id, '2026-11-06T20:00:00.000Z']]);
        end(); expect(host.prompt(record.id, 'Next work', 'you')).toBe(true);
        expect(prompts.at(-1)).toBe('Next work');
        expect(host.rowsFor(record.id).filter((r) => r.event.kind === 'message' && r.event.speaker === 'you').map((r) => (r.event as { text: string }).text)).toEqual(['Continue the task', 'Next work']);
    });
    it('retains the notice across a refused send instead of consuming it', () => {
        const { host, record, prompts, cleared } = setup({ redockAt: '2026-11-06T20:00:00.000Z', failFirst: true });
        try { host.prompt(record.id, 'First attempt', 'you'); } catch { /* the provider refused */ }
        expect(cleared).toEqual([]);
        host.prompt(record.id, 'Retry work', 'you');
        expect(prompts[0]).toMatch(/hibernat|redock/i);
        expect(cleared).toEqual([[record.id, '2026-11-06T20:00:00.000Z']]);
    });
    it('keeps a separate held trust instruction alongside the redock notice', () => {
        const { host, record, prompts } = setup({ redockAt: '2026-11-06T20:00:00.000Z' });
        host.holdForNextWork(record.id, 'Genie trust instructions must remain in this first turn.');
        host.prompt(record.id, 'Continue work', 'you');
        expect(prompts[0]).toContain('Genie trust instructions');
        expect(prompts[0]).toMatch(/hibernat|redock/i);
        expect(prompts[0]!.endsWith('Continue work')).toBe(true);
    });
    it('leaves ordinary work unchanged when the workspace was not redocked', () => {
        const { host, record, prompts, cleared } = setup();
        expect(host.prompt(record.id, 'Normal work', 'you')).toBe(true);
        expect(prompts).toEqual(['Normal work']); expect(cleared).toEqual([]);
    });
});
