import { describe, expect, it } from 'vitest';
import { agentViewAction } from '../src/core/keys.js';
import { chipRow } from '../src/core/session-timeline.js';
import type { StreamEvent } from '../src/core/stream-event.js';
import type { TimedEvent } from '../src/core/stream-view.js';

/**
 * THE CHIPS ROW (the board). The SESSION timeline strip that sat above it went in beta.64 (the agent pulse replaced it).
 * The chips: `All 412 · Thoughts 61 · Tools 288 · Edits 17`, All active when nothing is filtered. `L` toggles the Lanes drawer.
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

describe('chipRow', () => {
    it('All with the row count, the four lanes with their counts, then Usage and Errors; All is on when nothing is filtered', () => {
        expect(chipRow(rows, null)).toEqual([
            // Over the ACTIVITY rows: the fixture's one message is a chat message, so All is 7 and there is no Messages chip.
            { id: 'all', label: 'All', n: 7, on: true },
            { id: 'thoughts', label: 'Thoughts', n: 1, on: false },
            { id: 'tools', label: 'Tools', n: 1, on: false },
            { id: 'edits', label: 'Edits', n: 2, on: false },
            { id: 'usage', label: 'Usage', n: 1, on: false },
            { id: 'approvals', label: 'Approvals', n: 0, on: false },
            { id: 'errors', label: 'Errors', n: 0, on: false },
        ]);
    });

    it('a selection turns its lanes on and All off; a measured zero is kept', () => {
        const chips = chipRow(rows.filter((r) => r.event.kind !== 'think'), ['edits', 'thoughts']);
        expect(chips.find((c) => c.id === 'all')!.on).toBe(false);
        expect(chips.find((c) => c.id === 'edits')).toMatchObject({ n: 2, on: true });
        expect(chips.find((c) => c.id === 'thoughts')).toMatchObject({ n: 0, on: true });
        expect(chips.find((c) => c.id === 'messages')).toBeUndefined();
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
