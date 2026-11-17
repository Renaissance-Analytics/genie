import { describe, expect, it } from 'vitest';
import { HeadroomBoard } from '../src/core/headroom-board.js';
import { readLimitWindow, type Headroom, type LimitWindow } from '../src/core/headroom.js';

// Tynn #478 (Accounts S5): a rate-limit reading belongs to the account it was read on. Fixtures use no real person.
const T0 = 1_000_000;
const MIN = 60_000;
const HOUR = 3_600_000;
const A = { provider: 'claude', accountId: `account_${'a'.repeat(32)}` };
const B = { provider: 'claude', accountId: `account_${'b'.repeat(32)}` };

const win = (window: string, leftPct: number, resetsAtMs: number): LimitWindow => ({ window, usedPct: 100 - leftPct, leftPct, resetsAtMs, over: false });
const room = (leftPct: number, resetsAtMs = T0 + 5 * HOUR): Headroom => {
    const w = win('5h', leftPct, resetsAtMs);
    return { plan: null, window: w.window, leftPct, resetsAtMs, over: false, windows: [w] };
};
const stampOf = (source: { accountId: string }, runId: string) => ({ accountId: source.accountId, runId });
const find = (board: HeadroomBoard, now: number, accountId: string) => board.accounts(now).find((entry) => entry.accountId === accountId);

describe('the board keeps one reading per ACCOUNT, not one per provider', () => {
    it('A’s reading does not overwrite B’s, and B’s does not wait out A’s buffer', () => {
        const board = new HeadroomBoard();
        expect(board.offer(A, room(80), T0, MIN, stampOf(A, 'run_a'))).toBe(true);
        expect(board.offer(B, room(30), T0 + 1, MIN, stampOf(B, 'run_b'))).toBe(true);
        expect(find(board, T0 + 2, A.accountId)?.room.leftPct).toBe(80);
        expect(find(board, T0 + 2, B.accountId)?.room.leftPct).toBe(30);
        expect(board.accounts(T0 + 2)).toHaveLength(2);
    });

    it('CONTROL: a second reading from the SAME account inside its buffer is still ignored', () => {
        const board = new HeadroomBoard();
        expect(board.offer(A, room(80), T0, MIN, stampOf(A, 'run_a'))).toBe(true);
        expect(board.offer(A, room(40), T0 + MIN - 1, MIN, stampOf(A, 'run_a'))).toBe(false);
        expect(find(board, T0 + 1, A.accountId)?.room.leftPct).toBe(80);
        expect(board.offer(A, room(40), T0 + MIN, MIN, stampOf(A, 'run_a'))).toBe(true);
        expect(find(board, T0 + MIN, A.accountId)?.room.leftPct).toBe(40);
    });

    it('a reading that arrives AFTER the agent moved to B stays with A, and says which run read it', () => {
        const board = new HeadroomBoard();
        board.offer(B, room(30), T0, MIN, stampOf(B, 'run_2'));
        // The agent was launched on A (run_1), then moved to B (run_2); run_1's reading lands late.
        board.offer(A, room(55), T0 + 10, MIN, stampOf(A, 'run_1'));
        expect(find(board, T0 + 20, A.accountId)).toMatchObject({ provider: 'claude', runId: 'run_1', room: { leftPct: 55 } });
        expect(find(board, T0 + 20, B.accountId)).toMatchObject({ runId: 'run_2', room: { leftPct: 30 } });
    });

    it('CONTROL: another provider’s account is its own entry too', () => {
        const board = new HeadroomBoard();
        const codex = { provider: 'codex', accountId: `account_${'c'.repeat(32)}` };
        board.offer(A, room(80), T0, MIN, stampOf(A, 'run_a'));
        board.offer(codex, room(10), T0, MIN, stampOf(codex, 'run_c'));
        expect(board.accounts(T0 + 1).map((e) => e.provider).sort()).toEqual(['claude', 'codex']);
    });
});

describe('a window past its reset reads Refreshed, never a stale percentage', () => {
    it('before the reset the figure stands; at and after it the window is Refreshed and carries no figure', () => {
        const w = win('5h', 12, T0 + HOUR);
        expect(readLimitWindow(w, T0 + HOUR - 1)).toEqual({ refreshed: false, window: '5h', leftPct: 12, over: false, resetsAtMs: T0 + HOUR });
        const after = readLimitWindow(w, T0 + HOUR);
        expect(after).toEqual({ refreshed: true, window: '5h' });
        expect(Object.keys(after)).not.toContain('leftPct');
    });

    it('a spent window is Refreshed too once its reset has passed', () => {
        const spent: LimitWindow = { window: '7d', usedPct: 120, leftPct: 0, resetsAtMs: T0 + HOUR, over: true };
        expect(readLimitWindow(spent, T0 + HOUR + 1)).toEqual({ refreshed: true, window: '7d' });
    });

    it('the board serves it Refreshed until a new reading arrives, then the new figure', () => {
        const board = new HeadroomBoard();
        board.offer(A, room(12, T0 + HOUR), T0, MIN, stampOf(A, 'run_a'));
        expect(find(board, T0 + HOUR - 1, A.accountId)?.windows).toEqual([expect.objectContaining({ window: '5h', refreshed: false, leftPct: 12 })]);
        expect(find(board, T0 + HOUR + MIN, A.accountId)?.windows).toEqual([{ window: '5h', refreshed: true }]);
        board.offer(A, room(90, T0 + 6 * HOUR), T0 + HOUR + 2 * MIN, MIN, stampOf(A, 'run_a'));
        expect(find(board, T0 + HOUR + 2 * MIN, A.accountId)?.windows).toEqual([expect.objectContaining({ window: '5h', refreshed: false, leftPct: 90 })]);
    });

    it('only the elapsed window is Refreshed; the other keeps its figure', () => {
        const board = new HeadroomBoard();
        const five = win('5h', 20, T0 + HOUR);
        const week = win('7d', 60, T0 + 100 * HOUR);
        board.offer(A, { plan: null, window: '5h', leftPct: 20, resetsAtMs: five.resetsAtMs, over: false, windows: [five, week] }, T0, MIN, stampOf(A, 'run_a'));
        const windows = find(board, T0 + 2 * HOUR, A.accountId)?.windows ?? [];
        expect(windows.find((w) => w.window === '5h')).toEqual({ window: '5h', refreshed: true });
        expect(windows.find((w) => w.window === '7d')).toMatchObject({ refreshed: false, leftPct: 60 });
    });
});
