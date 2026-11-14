import type { SessionStore } from '@particle-academy/prism-harness';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentSession, type DriverEvents } from '../src/core/session.js';
import { mintAgentId } from '../src/core/identity.js';
import type { StreamEvent } from '../src/core/stream-event.js';
import type { CommandRunRef } from '../src/core/command-run.js';

// Actual session publication and persistence with a memory store/fake driver, no native lock, disk or provider.
const sessions: AgentSession[] = [];
afterEach(async () => { for (const session of sessions.splice(0)) { await session.stop('SIGTERM', { graceMs: 0 }); await session.settled(); } });
function rig() {
    const kv = new Map<string, Record<string, unknown>>();
    const logs = new Map<string, Record<string, unknown>[]>();
    const store = {
        get: async (key: string) => kv.get(key) ?? null,
        put: async (key: string, value: Record<string, unknown>) => { kv.set(key, value); },
        forget: async (key: string) => { kv.delete(key); logs.delete(key); },
        withLock: async <T>(_key: string, body: () => T | Promise<T>) => body(), durability: () => 'durable',
        appendLog: async (key: string, values: readonly Record<string, unknown>[]) => { const log = logs.get(key) ?? []; log.push(...values); logs.set(key, log); },
        readLog: async (key: string) => logs.get(key)?.slice() ?? null,
        logLength: async (key: string) => logs.get(key)?.length ?? null,
        clearLog: async (key: string) => { logs.set(key, []); },
    } as unknown as SessionStore;
    let driver: DriverEvents = {};
    const rows: StreamEvent[] = [];
    const session = new AgentSession({
        agentId: mintAgentId(), cwd: '/fixture', store,
        processTree: { snapshot: () => [], killTree: () => ({ killed: 0, refused: false }) },
        driverFactory: (options) => { driver = options.events; return { start: () => {}, prompt: () => {}, kill: () => { driver.onExit?.(0, null); }, get cliSessionId() { return null; } }; },
        onEvent: (event) => { rows.push(event); },
    });
    sessions.push(session); session.start();
    const run: CommandRunRef = { processId: 'command-one', workspaceId: 'work', command: 'php artisan test' };
    return { session, rows, run, update: (value: Record<string, unknown>) => driver.onUpdate?.(value), saved: () => [...logs.values()].flat().map((entry) => entry.message as StreamEvent) };
}

describe('a live command reference in the agent ledger (#633)', () => {
    it('publishes synchronously while the provider tool call is still in progress, before any turn-end response', () => {
        const w = rig();
        w.update({ sessionUpdate: 'tool_call', toolCallId: 'provider-call', name: 'mcp__genie__services', status: 'in_progress', rawInput: { action: 'exec', command: w.run.command } });
        w.session.commandStarted(w.run);
        expect(w.rows).toContainEqual(expect.objectContaining({ kind: 'notice', level: 'info', commandRun: w.run }));
    });

    it('keeps two identical command labels linked to their own exact runs rather than guessing by text', () => {
        const w = rig(); w.session.commandStarted(w.run); w.session.commandStarted({ ...w.run, processId: 'command-two' });
        const refs = w.rows.flatMap((event) => event.kind === 'notice' && event.commandRun ? [event.commandRun.processId] : []);
        expect(refs).toEqual(['command-one', 'command-two']);
    });

    it('drops unexpected sensitive fields instead of spreading internal metadata into the ledger', () => {
        const w = rig(); w.session.commandStarted({ ...w.run, secrets: ['fixture-private-633'], env: { DB_PASSWORD: 'fixture-private-633' } } as CommandRunRef);
        const event = w.rows.find((row) => row.kind === 'notice' && row.commandRun);
        expect(event).toMatchObject({ commandRun: w.run });
        expect(Object.keys((event as Extract<StreamEvent, { kind: 'notice' }>).commandRun!).sort()).toEqual(['command', 'processId', 'workspaceId']);
        expect(JSON.stringify(event)).not.toContain('fixture-private-633');
    });

    it('retains the safe reference in the recorded ledger for a later reconnect', async () => {
        const w = rig(); w.session.commandStarted(w.run); await w.session.settled();
        expect(w.saved()).toContainEqual(expect.objectContaining({ kind: 'notice', commandRun: w.run }));
    });

    it('CONTROL: ordinary notices retain their existing behavior without inventing command references', () => {
        const w = rig(); w.session.notice('ordinary notice');
        expect(w.rows).toContainEqual({ kind: 'notice', level: 'warning', message: 'ordinary notice' });
    });
});
