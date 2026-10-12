import { describe, expect, it } from 'vitest';
import { agentViewAction } from '../src/core/keys.js';
import type { StreamEvent } from '../src/core/stream-event.js';
import { findRows, type TimedEvent } from '../src/core/stream-view.js';

/**
 * FIND IN STREAM (`/`, the board's `Find in stream` beside the chips): a substring over what each row SAYS — the
 * ledger's main text, the speaker, the kind column — case-insensitive. Structure stays: turn markers and the
 * compaction divider are never hidden by a find, for the same reason they survive a lane filter. A blank query is
 * no find at all.
 */
const t = (id: string, event: StreamEvent): TimedEvent => ({ id, event, at: 1_000 });
const rows: TimedEvent[] = [
    t('t1', { kind: 'turn', n: 1, by: 'you' }),
    t('m1', { kind: 'message', speaker: 'you', peerName: null, text: 'Run the Artisan tests please' }),
    t('k1', { kind: 'think', text: 'the suite lives under tests/Feature', tokens: null }),
    t('b1', { kind: 'tool', toolCallId: 'c1', name: 'Bash', title: 'php artisan test --filter=Challenge', status: 'completed', toolKind: 'execute', rawInput: null }),
    t('d1', { kind: 'divider', variant: 'compaction', before: 189_000, after: 46_000 }),
    t('m2', { kind: 'message', speaker: 'peer', peerName: 'wren', text: 'done' }),
];

describe('findRows', () => {
    it('keeps the rows whose text, speaker or kind contains the query, case-insensitively — and every structure row', () => {
        expect(findRows(rows, 'artisan').map((r) => r.id)).toEqual(['t1', 'm1', 'b1', 'd1']);
        expect(findRows(rows, 'WREN').map((r) => r.id)).toEqual(['t1', 'd1', 'm2']);
        expect(findRows(rows, 'think').map((r) => r.id)).toEqual(['t1', 'k1', 'd1']);
    });

    it('a blank query is no find: every row', () => {
        expect(findRows(rows, '')).toBe(rows);
        expect(findRows(rows, '   ')).toBe(rows);
    });

    it('nothing matches → only the structure rows remain (the surface says so in a sentence)', () => {
        expect(findRows(rows, 'zzz').map((r) => r.id)).toEqual(['t1', 'd1']);
    });
});

describe('/ opens the find', () => {
    const press = (key: string, typing = false) => agentViewAction({ key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, typing });
    it('bound, never while typing', () => {
        expect(press('/')).toBe('find');
        expect(press('/', true)).toBeNull();
    });
});
