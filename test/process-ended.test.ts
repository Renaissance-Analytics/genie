import { describe, expect, it } from 'vitest';
import { processEnded } from '../src/core/agent-view.js';
import type { LiveSession } from '../src/core/roster.js';
import type { StreamEvent } from '../src/core/stream-event.js';
import type { TimedEvent } from '../src/core/stream-view.js';

/**
 * THE PROCESS-ENDED BLOCK (the board's right column, error state): `Process ended`, the engine's own words — the
 * reason the session layer recorded and the provider's recent stderr — the last tool call (which has no result),
 * `Restart and resume`, `Copy log`. Facts only: no RSS, no exit code Genie did not receive; absent unless the
 * session actually failed.
 */
const t = (id: string, event: StreamEvent): TimedEvent => ({ id, event, at: 1_000 });
const rows: TimedEvent[] = [
    t('t1', { kind: 'turn', n: 9, by: 'you' }),
    t('b1', { kind: 'tool', toolCallId: 'c1', name: 'Bash', title: 'php artisan test', status: 'completed', toolKind: 'execute', rawInput: null }),
    t('b2', { kind: 'tool', toolCallId: 'c2', name: 'Bash', title: 'php artisan test --parallel', status: 'in_progress', toolKind: 'execute', rawInput: null }),
];
const session = (over: Partial<LiveSession> = {}): LiveSession =>
    ({ running: false, turnState: 'failed', startedAt: 1, pendingApproval: null, failure: { reason: 'codex: acp: transport closed (EOF)', fixes: ['restart'] }, contextUsed: null, contextSize: null, lastDelivery: null, collaborators: null, commsAgeSeconds: null, plan: null, ...over }) as LiveSession;
const log = ['PHP Fatal error: Allowed memory size exhausted', '[worker 6] killed', '[worker 7] killed'];

describe('processEnded', () => {
    it('a failed session: the reason, the last tool call, the log as the engine wrote it', () => {
        expect(processEnded(session(), rows, log)).toEqual({
            reason: 'codex: acp: transport closed (EOF)',
            lastTool: 'Bash  php artisan test --parallel',
            log: 'PHP Fatal error: Allowed memory size exhausted\n[worker 6] killed\n[worker 7] killed',
            exit: null,
        });
    });

    it('no stderr → an empty log, not a filler line; no tool rows → no last tool', () => {
        expect(processEnded(session(), [], [])).toEqual({ reason: 'codex: acp: transport closed (EOF)', lastTool: null, log: '', exit: null });
    });

    it('absent unless the session failed: working, idle, stopped, no session', () => {
        expect(processEnded(session({ turnState: 'working', failure: null }), rows, log)).toBeNull();
        expect(processEnded(session({ turnState: 'idle', failure: null }), rows, log)).toBeNull();
        expect(processEnded(session({ turnState: 'stopped', failure: null }), rows, log)).toBeNull();
        expect(processEnded(null, rows, log)).toBeNull();
    });
});
