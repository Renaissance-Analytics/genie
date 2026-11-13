import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AGENT_READ_TRACE, measureAgentRead, measureAgentReadAsync, type AgentReadTrace } from '../src/core/agent-read-timing.js';
import { AgentDetailViews, type AgentPushPayload } from '../src/core/agent-push-wire.js';
import { AgentPush } from '../src/main/agent-push.js';

// Trace clocks are supplied by the actual operation's observed elapsed interval, never by a requested work budget.
const globals = globalThis as unknown as Record<symbol, unknown>;
let clock = 0;
let now: ReturnType<typeof vi.spyOn>;
const trace = (): AgentReadTrace => {
    const value: AgentReadTrace = { agentId: 'fixture-agent', events: [] };
    globals[AGENT_READ_TRACE] = value;
    return value;
};
beforeEach(() => { clock = 0; delete globals[AGENT_READ_TRACE]; now = vi.spyOn(performance, 'now').mockImplementation(() => clock); });
afterEach(() => { delete globals[AGENT_READ_TRACE]; vi.restoreAllMocks(); });

describe('physical agent-read stage intervals (Tynn #564)', () => {
    it('records elapsed synchronous work while preserving the actual operation result', () => {
        const evidence = trace();
        const actual = { marker: 'actual operation result' };
        expect(measureAgentRead('fixture-agent', 'decode', () => { clock += 7; return actual; })).toBe(actual);
        expect(evidence.events).toEqual([{ stage: 'decode', ms: 7 }]);
    });

    it('records async blob work through completion, rather than the time the promise was created', async () => {
        const evidence = trace();
        let release!: (value: string) => void;
        const held = new Promise<string>((resolve) => { release = resolve; });
        const pending = measureAgentReadAsync('fixture-agent', 'blob', () => held);
        clock += 13; release('actual bytes');
        expect(await pending).toBe('actual bytes');
        expect(evidence.events).toEqual([{ stage: 'blob', ms: 13 }]);
    });

    it('times the real AgentPush producer independently of the subsequent send operation', () => {
        const evidence = trace();
        const push = new AgentPush({
            detailFor: () => { clock += 7; return { rows: ['fixture row'] }; },
            send: () => { clock += 11; },
            now: () => 0, schedule: () => () => {},
        });
        push.watch('fixture-agent', true);
        expect(evidence.events.find((event) => event.stage === 'producer')?.ms).toBe(7);
    });

    it('times real page reconstruction independently of a view callback', () => {
        const evidence = trace();
        type Payload = AgentPushPayload<{ state: string }, string>;
        let deliver!: (payload: Payload) => void;
        const views = new AgentDetailViews<{ state: string }, string>((_id, onPayload) => { deliver = onPayload; return () => {}; });
        const seen: unknown[] = [];
        const off = views.subscribe('fixture-agent', (detail) => { clock += 50; seen.push(detail); });
        const payload: Payload = { seq: 1, detail: { state: 'fixture' }, rows: {
            base: null, keep: 0, get append() { clock += 6; return ['fixture row']; },
        } };
        deliver(payload); off();
        expect(seen).toEqual([{ state: 'fixture', rows: ['fixture row'] }]);
        expect(evidence.events.find((event) => event.stage === 'rebuild')?.ms).toBe(6);
    });

    it('CONTROL: ordinary operations read no tracing clock when no extra diagnostic is active', async () => {
        const sync = vi.fn(() => 'ordinary'), asyncOp = vi.fn(async () => 'ordinary async');
        expect(measureAgentRead('fixture-agent', 'producer', sync)).toBe('ordinary');
        expect(await measureAgentReadAsync('fixture-agent', 'blob', asyncOp)).toBe('ordinary async');
        expect(sync).toHaveBeenCalledTimes(1); expect(asyncOp).toHaveBeenCalledTimes(1);
        expect(now).not.toHaveBeenCalled();
    });

    it('CONTROL: an extra open does not collect timings from a different agent', () => {
        const evidence = trace();
        expect(measureAgentRead('another-agent', 'producer', () => { clock += 5; return 42; })).toBe(42);
        expect(evidence.events).toEqual([]);
    });

    it('CONTROL: tracing never replaces an operation failure with a success', () => {
        trace();
        const failure = new Error('actual operation failed');
        expect(() => measureAgentRead('fixture-agent', 'producer', () => { throw failure; })).toThrow(failure);
    });
});
