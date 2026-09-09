import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { AgentInboxBrokerEvent, AgentInboxMessagePreview } from '../types';

/**
 * "I want to know when agents are talking to each other" — genie#546.
 *
 * The owner's first named event. A message landing in an agent's inbox is an
 * INTERRUPT for that agent (it can glow a terminal and nudge a pty), so it is
 * one of the few moments in Genie that already means "something changed and a
 * person might want to know".
 *
 * Wired HERE — in the fan-out that already turns every broker event into
 * Genie's own surfaces — rather than in `broker.ts`, which owns no I/O and
 * should keep owning none.
 *
 * ## The distinction this test is careful NOT to fake
 *
 * genie#543 is still in flight. Until it lands, a cron nudging an agent sends as
 * the HUMAN, so "your scheduled job reported in" is byte-identical on the wire
 * to "the person typed you a message". This deliberately stays silent for a
 * human sender rather than guessing, and the `genie:` prefix cases below are the
 * proof that machine notices route to their own alert the moment #543 gives them
 * their own ids.
 */

const emitter = vi.hoisted(() => ({ fn: null as null | ((e: AgentInboxBrokerEvent) => void) }));
vi.mock('../broker', () => ({
    agentInboxBroker: {
        setEmitter: (fn: (e: AgentInboxBrokerEvent) => void) => {
            emitter.fn = fn;
        },
    },
}));
vi.mock('../../remote', () => ({ broadcastLocal: () => 0 }));
vi.mock('../../mobile/server', () => ({ mobileEmit: () => 0 }));
vi.mock('../../terminal/ipc', () => ({ broadcastTerminalAttention: () => 0 }));
vi.mock('../../terminal/agent-pulse', () => ({ agentPulse: { mark: () => {} } }));

const alerts = vi.hoisted(() => ({ played: [] as string[] }));
vi.mock('../../notify-sound', () => ({
    playAlert: (kind: string) => {
        alerts.played.push(kind);
        return true;
    },
}));

import { installAgentInboxPresence } from '../presence';

function preview(from: string): AgentInboxMessagePreview {
    return {
        kind: 'dm',
        from,
        fromLabel: from,
        seq: 1,
        ts: Date.now(),
        preview: 'hello',
    };
}

/** Push one broker event through the installed fan-out. */
function emit(ev: AgentInboxBrokerEvent): void {
    if (!emitter.fn) throw new Error('presence never installed an emitter');
    emitter.fn(ev);
}

beforeEach(() => {
    alerts.played.length = 0;
    emitter.fn = null;
    installAgentInboxPresence();
});

describe('an agent messaging another agent', () => {
    it('raises agentMessage', () => {
        emit({ type: 'message', preview: preview('claude-reviewer-7') });
        expect(alerts.played).toEqual(['agentMessage']);
    });
});

describe('a machine reporting in', () => {
    it('raises automatedNotice for a Genie system announcement', () => {
        emit({ type: 'message', preview: preview('genie:system') });
        expect(alerts.played).toEqual(['automatedNotice']);
    });

    it('raises automatedNotice for the cron and process senders genie#543 adds', () => {
        emit({ type: 'message', preview: preview('genie:cron:spec-1') });
        emit({ type: 'message', preview: preview('genie:process:proc-9') });
        expect(alerts.played).toEqual(['automatedNotice', 'automatedNotice']);
    });
});

describe('what does NOT chime', () => {
    it('stays silent for a message the person at the keyboard sent', () => {
        // You do not need a chime for the message you just typed. It is also
        // the identity a cron currently borrows, so guessing here would label a
        // scheduled job as "you".
        emit({ type: 'message', preview: preview('human') });
        expect(alerts.played).toEqual([]);
    });

    it('POSITIVE CONTROL: the same fan-out DOES chime for an agent sender', () => {
        // Without this, a wiring that never fired at all would pass the
        // assertion above.
        emit({ type: 'message', preview: preview('human') });
        emit({ type: 'message', preview: preview('some-agent') });
        expect(alerts.played).toEqual(['agentMessage']);
    });

    it('stays silent for presence, lag and lifecycle events', () => {
        // Only a MESSAGE is an event a person might want announced. Presence
        // churns constantly as terminals come and go.
        emit({ type: 'lag', count: 3 } as AgentInboxBrokerEvent);
        emit({ type: 'offline', agentId: 'a1' });
        emit({ type: 'interrupt', terminalId: 't1' });
        expect(alerts.played).toEqual([]);
    });
});
