import { describe, expect, it } from 'vitest';
import { agentViewAction } from '../src/core/keys.js';
import type { LiveSession } from '../src/core/roster.js';
import { chipRow, sessionTimeline } from '../src/core/session-timeline.js';
import type { StreamEvent } from '../src/core/stream-event.js';
import type { TimedEvent } from '../src/core/stream-view.js';

/**
 * THE SESSION TIMELINE STRIP (the board, 46px): turn segments `T9 … T14` placed by when each turn started, one
 * tick per event coloured by KIND (edit emerald, message blue, thought violet, tool grey), a legend, and the head bar
 * at the right in the session's state. Under it the CHIPS ROW: `All 412 · Messages 14 · Thoughts 61 · Tools 288 ·
 * Edits 17` — the lane filter as chips, All active when nothing is filtered. `L` toggles the Lanes drawer.
 */
const t = (id: string, event: StreamEvent, at: number | null): TimedEvent => ({ id, event, at });
const tool = (name: string, toolKind: 'edit' | 'execute'): StreamEvent => ({ kind: 'tool', toolCallId: id(), name, title: null, status: 'completed', toolKind, rawInput: null });
let seq = 0;
const id = () => `c${seq++}`;
const rows: TimedEvent[] = [
    t('t1', { kind: 'turn', n: 1, by: 'you' }, 1_000),
    t('m1', { kind: 'message', speaker: 'agent', peerName: null, text: 'hi' }, 1_200),
    t('k1', { kind: 'think', text: 'hmm', tokens: null }, 1_400),
    t('b1', tool('Bash', 'execute'), 1_600),
    t('e1', tool('Edit', 'edit'), 1_800),
    t('t2', { kind: 'turn', n: 2, by: 'you' }, 2_000),
    t('u1', { kind: 'usage', used: 1_000, size: 200_000, cost: null }, 2_200),
    t('e2', tool('Edit', 'edit'), 3_000),
];
const session = (over: Partial<LiveSession> = {}): LiveSession =>
    ({ running: true, turnState: 'working', startedAt: 1, pendingApproval: null, failure: null, contextUsed: null, contextSize: null, lastDelivery: null, collaborators: null, commsAgeSeconds: null, plan: null, ...over }) as LiveSession;

describe('sessionTimeline', () => {
    it('segments per turn by start time, ticks per event by kind (usage, turns and dividers draw none), the head in the session’s state', () => {
        const tl = sessionTimeline(rows, session())!;
        expect(tl.segments).toEqual([
            { label: 'T1', rowId: 't1', x: 0, w: 0.5 },
            { label: 'T2', rowId: 't2', x: 0.5, w: 0.5 },
        ]);
        expect(tl.ticks).toEqual([
            { id: 'm1', x: 0.1, kind: 'message' },
            { id: 'k1', x: 0.2, kind: 'thought' },
            { id: 'b1', x: 0.3, kind: 'tool' },
            { id: 'e1', x: 0.4, kind: 'edit' },
            { id: 'e2', x: 1, kind: 'edit' },
        ]);
        expect(tl.head).toBe('ok');
    });

    it('head: parked → warn, failed → bad, idle → null, no session → null', () => {
        expect(sessionTimeline(rows, session({ pendingApproval: { id: 'ap', question: 'q', options: [] } as unknown as LiveSession['pendingApproval'] }))!.head).toBe('warn');
        expect(sessionTimeline(rows, session({ turnState: 'failed', failure: { reason: 'exit 137', fixes: [] } }))!.head).toBe('bad');
        expect(sessionTimeline(rows, session({ turnState: 'idle' }))!.head).toBeNull();
        expect(sessionTimeline(rows, null)!.head).toBeNull();
    });

    it('no timed rows → null (a sentence, not an empty strip); rows without turn markers still get ticks and no segments', () => {
        expect(sessionTimeline([], session())).toBeNull();
        expect(sessionTimeline(rows.map((r) => ({ ...r, at: null })), session())).toBeNull();
        const noTurns = sessionTimeline(rows.filter((r) => r.event.kind !== 'turn'), session())!;
        expect(noTurns.segments).toEqual([]);
        expect(noTurns.ticks).toHaveLength(5);
    });
});

describe('chipRow', () => {
    it('All with the row count, then the four lanes with their counts; All is on when nothing is filtered', () => {
        expect(chipRow(rows, null)).toEqual([
            { id: 'all', label: 'All', n: 8, on: true },
            { id: 'messages', label: 'Messages', n: 1, on: false },
            { id: 'thoughts', label: 'Thoughts', n: 1, on: false },
            { id: 'tools', label: 'Tools', n: 1, on: false },
            { id: 'edits', label: 'Edits', n: 2, on: false },
        ]);
    });

    it('a selection turns its lanes on and All off; a measured zero is kept', () => {
        const chips = chipRow(rows.filter((r) => r.event.kind !== 'think'), ['edits', 'thoughts']);
        expect(chips.find((c) => c.id === 'all')!.on).toBe(false);
        expect(chips.find((c) => c.id === 'edits')).toMatchObject({ n: 2, on: true });
        expect(chips.find((c) => c.id === 'thoughts')).toMatchObject({ n: 0, on: true });
        expect(chips.find((c) => c.id === 'messages')).toMatchObject({ n: 1, on: false });
    });
});

describe('L toggles the Lanes drawer', () => {
    const press = (key: string, typing = false) => agentViewAction({ key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, typing });
    it('in either case, never while typing', () => {
        expect(press('l')).toBe('toggle-lanes');
        expect(press('L')).toBe('toggle-lanes');
        expect(press('l', true)).toBeNull();
    });
});
