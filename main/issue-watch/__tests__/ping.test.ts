import { describe, it, expect, vi } from 'vitest';
import {
    resolveIssueWatchRecipients,
    dispatchIssueWatchPings,
    feedSignature,
    hasNewOrChangedItems,
    type IssueWatchAgent,
    type IssueWatchDispatchSinks,
} from '../ping';

/**
 * IssueWatch → agent ping routing (feature). Covers the LOCKED recipient rule
 * (designated set restricts; empty falls back to all handle-enabled; a
 * designated-but-not-handle-enabled agent is excluded), the notify-vs-wake
 * dispatch, and the baseline/new-item change-detection that prevents spam.
 */

const agent = (id: string, handle: boolean, action: 'notify' | 'wake' = 'notify'): IssueWatchAgent => ({
    terminalId: id,
    handle,
    action,
});

describe('resolveIssueWatchRecipients', () => {
    it('EMPTY designated set → every handle-enabled agent (fallback)', () => {
        const agents = [agent('a', true), agent('b', false), agent('c', true, 'wake')];
        const out = resolveIssueWatchRecipients([], agents);
        expect(out).toEqual([
            { terminalId: 'a', action: 'notify' },
            { terminalId: 'c', action: 'wake' },
        ]);
    });

    it('NON-EMPTY designated set → only the designated agents receive it', () => {
        const agents = [agent('a', true), agent('b', true, 'wake'), agent('c', true)];
        const out = resolveIssueWatchRecipients(['b'], agents);
        expect(out).toEqual([{ terminalId: 'b', action: 'wake' }]);
    });

    it('a DESIGNATED but NOT handle-enabled agent is excluded', () => {
        const agents = [agent('a', false), agent('b', true)];
        // 'a' is designated but has handle=false → excluded; 'b' not designated → excluded.
        expect(resolveIssueWatchRecipients(['a'], agents)).toEqual([]);
    });

    it('a designated id that is not an agent at all is simply ignored', () => {
        const agents = [agent('a', true)];
        expect(resolveIssueWatchRecipients(['ghost', 'a'], agents)).toEqual([
            { terminalId: 'a', action: 'notify' },
        ]);
    });
});

describe('dispatchIssueWatchPings (notify vs wake)', () => {
    it('routes wake → wake sink and notify → notify sink', () => {
        const notify = vi.fn();
        const wake = vi.fn(() => true);
        const sinks: IssueWatchDispatchSinks = { notify, wake };
        dispatchIssueWatchPings(
            [
                { terminalId: 'a', action: 'notify' },
                { terminalId: 'b', action: 'wake' },
            ],
            sinks,
        );
        expect(notify).toHaveBeenCalledExactlyOnceWith('a');
        expect(wake).toHaveBeenCalledExactlyOnceWith('b');
    });

    it('a wake that finds the agent busy (sink returns false) does not glow instead', () => {
        const notify = vi.fn();
        const wake = vi.fn(() => false); // busy → not woken
        dispatchIssueWatchPings([{ terminalId: 'b', action: 'wake' }], { notify, wake });
        expect(wake).toHaveBeenCalledOnce();
        expect(notify).not.toHaveBeenCalled();
    });
});

describe('change detection', () => {
    const items = (rows: Array<[string, string]>) => rows.map(([key, updatedAt]) => ({ key, updatedAt }));

    it('the FIRST snapshot (no prior) is a baseline and never pings', () => {
        expect(hasNewOrChangedItems(undefined, items([['k1', 't1']]))).toBe(false);
    });

    it('a genuinely NEW item pings', () => {
        const prev = feedSignature(items([['k1', 't1']]));
        expect(hasNewOrChangedItems(prev, items([['k1', 't1'], ['k2', 't1']]))).toBe(true);
    });

    it('an UPDATED item (advanced updatedAt) pings', () => {
        const prev = feedSignature(items([['k1', '2026-01-01T00:00:00Z']]));
        expect(hasNewOrChangedItems(prev, items([['k1', '2026-02-01T00:00:00Z']]))).toBe(true);
    });

    it('an identical re-sent snapshot does NOT ping', () => {
        const prev = feedSignature(items([['k1', 't1'], ['k2', 't2']]));
        expect(hasNewOrChangedItems(prev, items([['k1', 't1'], ['k2', 't2']]))).toBe(false);
    });

    it('a pure removal (nothing added/updated) does NOT ping', () => {
        const prev = feedSignature(items([['k1', 't1'], ['k2', 't2']]));
        expect(hasNewOrChangedItems(prev, items([['k1', 't1']]))).toBe(false);
    });
});
