import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { DURABLE_CALLBACKS } from '../src/core/engine-protocol.js';
import { agentRecord, mintAgentId } from '../src/core/identity.js';
import { memoryPair } from '../src/core/line-transport.js';
import type { DriverEvents, SessionDriverFactory } from '../src/core/session.js';
import { agentRowFor } from '../src/core/roster.js';
import { SessionEngineClient } from '../src/main/session-engine-client.js';
import { SessionEngineServer } from '../src/main/session-engine-server.js';
import { SessionHost, type DriverFor } from '../src/main/session-host.js';

it('story394: redock acknowledgement survives the authenticated engine link and carries its exact marker', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'genie2-redock-link-394-'));
    const token = 'test-redock-token', prompts: string[] = [], cleared: unknown[][] = [];
    const driverFor: DriverFor = () => (() => ({ start: () => {}, prompt: (p: unknown) => { prompts.push(String(p)); }, kill: () => {}, running: true, cliSessionId: null })) as SessionDriverFactory;
    const server = new SessionEngineServer({ token, build: 'test', schedule: (_ms, fn) => { const id = setImmediate(fn); return () => clearImmediate(id); } });
    const host = new SessionHost({ userData: dir, driverFor, processTree: { snapshot: () => [], killTree: () => ({ killed: 0, refused: false }) }, ...server.hostOptions() });
    server.attach(host);
    const client = new SessionEngineClient({ onRedockSent: (...args: unknown[]) => cleared.push(args) } as never);
    try {
        const [h, w] = memoryPair(); server.accept(h);
        expect(await client.connect(w, token)).toMatchObject({ ok: true });
        const stamp = '2026-11-06T21:00:00.000Z';
        const record = { ...agentRecord({ id: mintAgentId(), workspaceId: 'awake', name: 'atlas', provider: 'claude' }), redockAt: stamp };
        expect(await client.start(record, dir)).toEqual({ ok: true });
        expect(await client.prompt(record.id, 'Work after redock', 'you')).toBe(true);
        for (let n = 0; n < 8; n++) await new Promise((resolve) => setImmediate(resolve));
        expect(prompts[0]).toMatch(/hibernat|redock/i);
        expect(cleared).toEqual([[record.id, stamp]]);
        expect(DURABLE_CALLBACKS.has('redockSent' as never)).toBe(true);
    } finally {
        client.disconnect(); host.stopAll(); await host.settled();
        await rm(dir, { recursive: true, force: true });
    }
});

it('story394: the five-minute Sleeping boundary is pushed through the real engine replica without another turn', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'genie2-sleep-link-394-'));
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] }); vi.setSystemTime(1_800_000_000_000);
    let events: DriverEvents = {};
    const driverFor: DriverFor = () => ((options: { events: DriverEvents }) => { events = options.events; return { start: () => {}, prompt: () => {}, kill: () => {}, running: true, cliSessionId: null }; }) as SessionDriverFactory;
    const server = new SessionEngineServer({ token: 'sleep-link-token', build: 'test', schedule: (_ms, fn) => { const id = setImmediate(fn); return () => clearImmediate(id); } });
    const host = new SessionHost({ userData: dir, driverFor, processTree: { snapshot: () => [], killTree: () => ({ killed: 0, refused: false }) }, ...server.hostOptions() });
    server.attach(host); const client = new SessionEngineClient();
    const settle = async () => { for (let n = 0; n < 8; n++) await new Promise((resolve) => setImmediate(resolve)); };
    try {
        const [h, w] = memoryPair(); server.accept(h); expect(await client.connect(w, 'sleep-link-token')).toMatchObject({ ok: true });
        const record = agentRecord({ id: mintAgentId(), workspaceId: 'awake', name: 'atlas', provider: 'claude' });
        await client.start(record, dir); await client.prompt(record.id, 'First work', 'you');
        events.onTurnEnd?.({ stopReason: 'end_turn' } as never); await settle();
        vi.advanceTimersByTime(15_000); await settle();
        expect(agentRowFor(record, client.probe(record.id), Date.now).state).toBe('idle');
        const seen: string[] = []; client.subscribe((id) => { if (id === record.id) seen.push(agentRowFor(record, client.probe(record.id), Date.now).state); });
        vi.advanceTimersByTime(300_000); await settle();
        expect(seen).toContain('sleeping');
        expect(client.probe(record.id)?.turnState).toBe('idle');
    } finally { client.disconnect(); vi.useRealTimers(); host.stopAll(); await host.settled(); await rm(dir, { recursive: true, force: true }); }
});
