import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AgentSession, type DriverEvents } from '../src/core/session.js';
import { mintAgentId } from '../src/core/identity.js';
import { openDurableStore } from '../src/core/thread-store.js';
import type { StreamEvent } from '../src/core/stream-event.js';
import { promptDeliveries } from '../src/core/prompt-delivery.js';

describe('input held while the provider is unavailable', () => {
    it.each([
        ['rate_limit', 'resume'], ['overloaded', 'resume'], ['rate_limit', 'stop'], ['overloaded', 'stop'],
    ] as const)('keeps input from before and during %s through %s', async (kind, after) => {
        const dir = await mkdtemp(join(tmpdir(), 'genie-held-queue-'));
        let events: DriverEvents = {};
        let busy = false;
        const prompts: unknown[] = [];
        const rows: StreamEvent[] = [];
        const session = new AgentSession({
            agentId: mintAgentId(), cwd: dir, store: openDurableStore(dir),
            processTree: { snapshot: () => [], killTree: () => ({ killed: 0, refused: false }) },
            retryLater: () => () => {},
            onEvent: event => rows.push(event),
            driverFactory: options => {
                events = options.events;
                return { start() {}, kill() {}, cliSessionId: null, prompt(content) {
                    if (busy) throw new Error('Codex turn already in flight');
                    busy = true;
                    prompts.push(content);
                } };
            },
        });
        try {
            session.start();
            session.deliver('first', 'you');
            session.deliver('second, already queued', 'you');
            busy = false;
            events.onTurnEnd?.({ stopReason: null, isError: true, raw: 'error', failure: { kind, reason: kind } });
            expect(session.held).toBe(true);
            session.deliver('third, during hold', 'you');
            session.deliver('fourth, during hold', 'you');
            const pending = () => [...promptDeliveries(rows.map(event => ({ event }))).values()];
            if (after === 'stop') {
                await session.stop();
                session.resumeAfterLimit();
                expect(prompts).toEqual(['first']);
                expect(pending()).toEqual(['undelivered', 'undelivered', 'undelivered']);
                return;
            }
            session.resumeAfterLimit();
            expect(prompts).toEqual(['first', 'second, already queued']);
            expect(pending()).toEqual(['sent', 'queued', 'queued']);
            for (const text of ['third, during hold', 'fourth, during hold']) {
                busy = false;
                events.onTurnEnd?.({ stopReason: 'end_turn', isError: false, raw: null });
                expect(prompts.at(-1)).toBe(text);
            }
            expect(prompts).toHaveLength(4);
            expect(pending()).toEqual(['sent', 'sent', 'sent']);
        } finally {
            await session.stop();
            await session.settled();
            await rm(dir, { recursive: true, force: true });
        }
    });
});
