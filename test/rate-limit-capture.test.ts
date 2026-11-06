import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import type { DriverEvents } from '../src/core/session.js';
import { sourceRateLimitNotice, type SourceProvider } from './fixtures/rate-limit-source.js';

// VM CLI has no top-level execution on import. These tests inject drivers and never start a provider.
const load = async () => { const file: string = './live/rate-limit-capture.live.js'; return import(file); };
const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); });
async function harness(options: { missing?: boolean; timeout?: boolean; badStop?: boolean; turnError?: boolean } = {}) {
    const directory = await mkdtemp(join(tmpdir(), 'genie-rate-capture-unit-')); dirs.push(directory);
    const order: string[] = [], prompts: string[] = [], frames: Partial<Record<SourceProvider, Record<string, unknown>>> = {};
    const createDriver = (provider: SourceProvider, _cwd: string, events: DriverEvents) => ({
        start: () => { order.push(`start:${provider}`); }, ready: Promise.resolve(),
        prompt: (text: string) => {
            order.push(`prompt:${provider}`); prompts.push(text);
            if (options.timeout) return;
            const frame: Record<string, unknown> = { ...sourceRateLimitNotice(provider), syntheticExtension: 'raw frame retained verbatim' }; frames[provider] = frame;
            if (options.missing) events.onUpdate?.({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'OK' }, _meta: frame._meta });
            else events.onUpdate?.(frame);
            events.onTurnEnd?.({ stopReason: 'end_turn', isError: options.turnError ?? false, raw: null });
        },
        stop: async () => { order.push(`stop:${provider}`); return { graceful: true, empty: !options.badStop, survivors: options.badStop ? null : 0, verified: !options.badStop }; },
    });
    return { directory, order, prompts, frames, createDriver };
}

it('captures unmodified notices after one tiny turn per provider, stopping the first before starting the second', async () => {
    const m = await load(), h = await harness();
    const result = await m.captureRateLimitTurns({ directory: h.directory, createDriver: h.createDriver, timeoutMs: 1000, settleMs: 0 });
    expect(result.code).toBe(0); expect(result.reports.map((r: { provider: string; turns: number; notices: number }) => [r.provider, r.turns, r.notices])).toEqual([['claude', 1, 1], ['codex', 1, 1]]);
    expect(h.order).toEqual(['start:claude', 'prompt:claude', 'stop:claude', 'start:codex', 'prompt:codex', 'stop:codex']);
    expect(h.prompts.length).toBe(2); expect(h.prompts.every(text => text.length < 120 && text.includes('OK'))).toBe(true);
    for (const provider of ['claude', 'codex'] as const) {
        const saved = JSON.parse(await readFile(join(h.directory, `${provider}.json`), 'utf8'));
        expect(saved.notices).toEqual([h.frames[provider]]);
    }
});
it('fails when a turn finishes without a raw rate-limit notice and does not confuse message metadata for a notice', async () => {
    const m = await load(), h = await harness({ missing: true });
    const result = await m.captureRateLimitTurns({ directory: h.directory, createDriver: h.createDriver, timeoutMs: 1000, settleMs: 0 });
    expect(result.code).toBe(1); expect(result.reports.length).toBe(2);
    expect(result.reports.every((r: { notices: number }) => r.notices === 0)).toBe(true);
    expect(result.failures.some((reason: string) => /notice/i.test(reason))).toBe(true);
    expect(JSON.parse(await readFile(join(h.directory, 'claude.json'), 'utf8')).notices).toEqual([]);
});
it('bounds a silent provider, always stops its owned driver and still attempts the other after verified cleanup', async () => {
    const m = await load(), h = await harness({ timeout: true });
    const result = await m.captureRateLimitTurns({ directory: h.directory, createDriver: h.createDriver, timeoutMs: 20, settleMs: 0 });
    expect(result.code).toBe(1); expect(result.failures.some((reason: string) => /timed out/i.test(reason))).toBe(true);
    expect(h.order).toEqual(['start:claude', 'prompt:claude', 'stop:claude', 'start:codex', 'prompt:codex', 'stop:codex']);
});
it('keeps raw captures but fails a provider-reported erroneous turn', async () => {
    const m = await load(), h = await harness({ turnError: true });
    const result = await m.captureRateLimitTurns({ directory: h.directory, createDriver: h.createDriver, timeoutMs: 1000, settleMs: 0 });
    expect(result.code).toBe(1); expect(result.reports.every((r: { notices: number }) => r.notices === 1)).toBe(true);
    expect(result.failures.some((reason: string) => /turn/i.test(reason))).toBe(true);
});
it('fails unverified cleanup and refuses to start a competing second provider', async () => {
    const m = await load(), h = await harness({ badStop: true });
    const result = await m.captureRateLimitTurns({ directory: h.directory, createDriver: h.createDriver, timeoutMs: 1000, settleMs: 0 });
    expect(result.code).toBe(1); expect(result.reports.length).toBe(1);
    expect(h.order).toEqual(['start:claude', 'prompt:claude', 'stop:claude']);
    expect(result.failures.some((reason: string) => /cleanup|stop|surviv/i.test(reason))).toBe(true);
});
