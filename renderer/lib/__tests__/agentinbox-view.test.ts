import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    HUMAN_ID,
    SEEN_CAP,
    forgetSeen,
    headcountOf,
    makeCoalescer,
    markSeen,
    parseSeenState,
    partitionWipeTargets,
    rowKeyOfPairKey,
    seenStorageKey,
    toggleSelection,
    wipeToken,
    serializeSeenState,
    sortByActivityDesc,
    sortedPairKey,
} from '../agentinbox-view';

/**
 * genie #64 parts 3 + 4 — the AgentInbox panel's PURE view logic.
 *
 * Extracted from AgentInboxFlyout so the ordering rule, the headcount pill and
 * the persisted client-side read state are testable without a DOM (the renderer
 * has no jsdom harness — see vitest.config.ts).
 */

describe('sortByActivityDesc', () => {
    const act = (ts: number, seq: number) => ({ ts, seq });

    it('orders by last activity, newest first', () => {
        const rows = [
            { id: 'old', a: act(100, 1) },
            { id: 'new', a: act(300, 3) },
            { id: 'mid', a: act(200, 2) },
        ];
        expect(sortByActivityDesc(rows, (r) => r.a).map((r) => r.id)).toEqual(['new', 'mid', 'old']);
    });

    it('tie-breaks same-millisecond activity by seq, newest first', () => {
        const rows = [
            { id: 'first', a: act(500, 7) },
            { id: 'second', a: act(500, 9) },
        ];
        expect(sortByActivityDesc(rows, (r) => r.a).map((r) => r.id)).toEqual(['second', 'first']);
    });

    it('sinks rows with NO activity below every row that has some, keeping their relative order', () => {
        // A channel nobody has posted in yet carries no activity at all; it must
        // not float to the top just because `undefined` sorts oddly.
        const rows = [
            { id: 'quiet-a', a: undefined },
            { id: 'loud', a: act(10, 1) },
            { id: 'quiet-b', a: undefined },
        ];
        expect(sortByActivityDesc(rows, (r) => r.a).map((r) => r.id)).toEqual([
            'loud',
            'quiet-a',
            'quiet-b',
        ]);
    });

    it('does not mutate the input', () => {
        const rows = [{ id: 'a', a: act(1, 1) }, { id: 'b', a: act(2, 2) }];
        const copy = [...rows];
        sortByActivityDesc(rows, (r) => r.a);
        expect(rows).toEqual(copy);
    });
});

describe('headcountOf', () => {
    it('counts online agents as active, everyone as total', () => {
        expect(
            headcountOf([
                { status: 'online' },
                { status: 'away' },
                { status: 'online' },
                { status: 'offline' },
            ]),
        ).toEqual({ active: 2, total: 4 });
    });

    it('is 0/0 with no agents', () => {
        expect(headcountOf([])).toEqual({ active: 0, total: 0 });
    });
});

describe('rowKeyOfPairKey', () => {
    // The broker reports a DM thread by PAIR key (`<idA>|<idB>`, sorted); the panel
    // keys its rows by role. A human↔agent thread and the human's DM with that same
    // agent are deliberately ONE row, so a `cleared` push for the pair has to land
    // on the very row key the read state and selection use.
    it('maps a human↔agent pair to the human DM row, whichever side the human is', () => {
        expect(rowKeyOfPairKey(`${HUMAN_ID}|zeta`)).toBe('d:zeta');
        expect(rowKeyOfPairKey(`alpha|${HUMAN_ID}`)).toBe('d:alpha');
    });

    it('maps an agent↔agent pair to the observed-pair row, sorted so either order agrees', () => {
        expect(rowKeyOfPairKey('b|a')).toBe('p:a|b');
        expect(rowKeyOfPairKey('a|b')).toBe('p:a|b');
    });

    it('does not throw on a malformed key', () => {
        expect(rowKeyOfPairKey('lonely')).toBe('p:lonely');
        expect(rowKeyOfPairKey('')).toBe('p:');
    });

    it('round-trips with sortedPairKey — the key the panel sends to delete a thread is the key it gets back', () => {
        // The panel builds a pair key to call `deleteThread`, and the host echoes a
        // pair key back on `agentinbox:cleared`. If those disagree the row survives
        // its own deletion until the next manual refresh.
        expect(rowKeyOfPairKey(sortedPairKey(HUMAN_ID, 'zeta'))).toBe('d:zeta');
        expect(rowKeyOfPairKey(sortedPairKey('zeta', HUMAN_ID))).toBe('d:zeta');
        expect(rowKeyOfPairKey(sortedPairKey('b', 'a'))).toBe('p:a|b');
    });

    it('sortedPairKey is order-independent', () => {
        expect(sortedPairKey('b', 'a')).toBe(sortedPairKey('a', 'b'));
        expect(sortedPairKey('a', 'b')).toBe('a|b');
    });
});

describe('multi-select wipe targets (genie #66)', () => {
    it('builds a token per kind and partitions it back into the host call shape', () => {
        const tokens = [
            wipeToken('channel', 'ws1:general'),
            wipeToken('dm', 'human|zeta'),
            wipeToken('channel', 'ws1:frontend'),
        ];
        expect(partitionWipeTargets(tokens)).toEqual({
            channelKeys: ['ws1:general', 'ws1:frontend'],
            pairKeys: ['human|zeta'],
        });
    });

    it('splits on the FIRST separator only — a channel key contains its own colon', () => {
        // `ws1:general` would be mangled by a naive split(':').
        expect(partitionWipeTargets([wipeToken('channel', 'ws1:general')])).toEqual({
            channelKeys: ['ws1:general'],
            pairKeys: [],
        });
    });

    it('dedupes and drops malformed / empty tokens rather than sending junk to the host', () => {
        expect(
            partitionWipeTargets([
                wipeToken('channel', 'ws1:general'),
                wipeToken('channel', 'ws1:general'),
                'garbage-no-prefix',
                '',
                'channel:',
            ]),
        ).toEqual({ channelKeys: ['ws1:general'], pairKeys: [] });
    });

    it('an empty selection partitions to an empty batch', () => {
        expect(partitionWipeTargets([])).toEqual({ channelKeys: [], pairKeys: [] });
    });

    it('toggleSelection adds then removes, returning a NEW set each time', () => {
        const empty = new Set<string>();
        const one = toggleSelection(empty, 'channel:x');
        expect([...one]).toEqual(['channel:x']);
        expect(one).not.toBe(empty);
        expect([...empty]).toEqual([]); // input untouched

        const back = toggleSelection(one, 'channel:x');
        expect([...back]).toEqual([]);
    });
});

describe('makeCoalescer (genie #66)', () => {
    // A mass delete emits ONE `cleared` push per target so per-key invalidation
    // stays exact — but every window listening would then refetch the directory
    // N times (3 requests each, over the relay on a remote Host). Collapse the
    // refetch, not the invalidation.
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('collapses a burst of schedules into a single run', () => {
        const run = vi.fn();
        const c = makeCoalescer(run, 40);
        for (let i = 0; i < 20; i++) c.schedule();
        expect(run).not.toHaveBeenCalled(); // nothing runs eagerly
        vi.advanceTimersByTime(40);
        expect(run).toHaveBeenCalledTimes(1);
    });

    it('runs again for a burst that arrives after the window closed', () => {
        const run = vi.fn();
        const c = makeCoalescer(run, 40);
        c.schedule();
        vi.advanceTimersByTime(40);
        c.schedule();
        vi.advanceTimersByTime(40);
        expect(run).toHaveBeenCalledTimes(2);
    });

    it('cancel drops a pending run — an unmounting panel must not refetch', () => {
        const run = vi.fn();
        const c = makeCoalescer(run, 40);
        c.schedule();
        c.cancel();
        vi.advanceTimersByTime(200);
        expect(run).not.toHaveBeenCalled();
    });
});

describe('client-side read state (persisted per workstation)', () => {
    it('keys storage per connection so the local window and each host window stay independent', () => {
        expect(seenStorageKey('local')).not.toEqual(seenStorageKey('host:abc'));
        expect(seenStorageKey('local')).toContain('local');
    });

    it('round-trips a seen map through storage', () => {
        const map = new Map([
            ['c:ws1:general', 12],
            ['d:agent-a', 5],
        ]);
        expect(parseSeenState(serializeSeenState(map))).toEqual(map);
    });

    it('treats missing / malformed / wrong-shaped storage as empty rather than throwing', () => {
        expect(parseSeenState(null)).toEqual(new Map());
        expect(parseSeenState('')).toEqual(new Map());
        expect(parseSeenState('{not json')).toEqual(new Map());
        expect(parseSeenState('[1,2,3]')).toEqual(new Map());
        // Non-numeric values are dropped, valid siblings survive.
        expect(parseSeenState('{"a":"nope","b":4}')).toEqual(new Map([['b', 4]]));
    });

    it('markSeen only ever moves a row FORWARD (a re-read of older history never un-reads it)', () => {
        let map = new Map<string, number>();
        map = markSeen(map, 'd:a', 5);
        expect(map.get('d:a')).toBe(5);
        map = markSeen(map, 'd:a', 3);
        expect(map.get('d:a')).toBe(5);
        map = markSeen(map, 'd:a', 9);
        expect(map.get('d:a')).toBe(9);
    });

    it('markSeen returns the SAME map when nothing changed (so React can skip the re-render)', () => {
        const map = markSeen(new Map(), 'd:a', 5);
        expect(markSeen(map, 'd:a', 4)).toBe(map);
        expect(markSeen(map, 'd:a', 6)).not.toBe(map);
    });

    it('markSeen does not mutate the input map', () => {
        const map = new Map([['d:a', 1]]);
        markSeen(map, 'd:a', 9);
        expect(map.get('d:a')).toBe(1);
    });

    it('forgetSeen drops a deleted conversation from the read state', () => {
        const map = new Map([
            ['d:a', 3],
            ['c:ws1:general', 4],
        ]);
        expect([...forgetSeen(map, 'd:a').keys()]).toEqual(['c:ws1:general']);
        // Unknown row → same map back, no churn.
        expect(forgetSeen(map, 'd:nope')).toBe(map);
    });

    it('caps the persisted blob, keeping the most-recently-active rows', () => {
        const map = new Map<string, number>();
        for (let i = 0; i < SEEN_CAP + 10; i++) map.set(`d:agent-${i}`, i);
        const restored = parseSeenState(serializeSeenState(map));
        expect(restored.size).toBe(SEEN_CAP);
        // The 10 lowest seqs (oldest activity) were dropped, the newest kept.
        expect(restored.has('d:agent-0')).toBe(false);
        expect(restored.has(`d:agent-${SEEN_CAP + 9}`)).toBe(true);
    });
});
