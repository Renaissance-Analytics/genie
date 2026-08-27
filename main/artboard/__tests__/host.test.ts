import { describe, expect, it, vi } from 'vitest';
import { reviewPost } from '../host';
import type { BoardPost } from '../board';

/**
 * THE RETURN PATH — a verdict has to reach the agent that is waiting for it.
 *
 * Recording the decision on the board is not enough: the agent cannot see the
 * board. If the verdict does not reach it, ArtBoard is a place where work goes
 * to be looked at and nothing happens, and the agent is back to guessing or
 * interrupting with a modal describing the mockup in words.
 *
 * The post carries the TERMINAL that made it — supplied host-side at dispatch
 * (`worker-host` passes `terminalId` into every plugin tool call), never claimed
 * by the agent, so a verdict cannot be routed somewhere by a post that asked to
 * be.
 */
const post = (over: Partial<BoardPost> = {}): BoardPost => ({
    id: 'p1',
    title: 'Login screen',
    kind: 'html',
    file: 'p1.html',
    createdAt: '2026-08-26T10:00:00.000Z',
    terminalId: 'term-7',
    ...over,
});

describe('reviewPost', () => {
    const deps = (over: Record<string, unknown> = {}) => ({
        readBoard: () => [post()],
        writeBoard: vi.fn(),
        deliver: vi.fn().mockReturnValue(true),
        now: () => '2026-08-26T12:00:00.000Z',
        ...over,
    });

    it('writes the verdict to the board AND tells the agent', () => {
        const d = deps();

        const got = reviewPost('ws-1', 'p1', { verdict: 'approved', comment: 'ship it' }, d);

        expect(got.ok).toBe(true);
        expect(d.writeBoard).toHaveBeenCalledTimes(1);
        expect((d.writeBoard as ReturnType<typeof vi.fn>).mock.calls[0][1][0].review).toMatchObject({
            verdict: 'approved',
            comment: 'ship it',
        });
        expect(d.deliver).toHaveBeenCalledWith('term-7', expect.stringContaining('Login screen'));
    });

    it('still RECORDS the verdict when the agent is gone', () => {
        // A terminal that has since closed must not lose the decision: the board
        // is the durable record, and the human made a real judgement either way.
        const d = deps({ deliver: vi.fn().mockReturnValue(false) });

        const got = reviewPost('ws-1', 'p1', { verdict: 'rejected' }, d);

        expect(d.writeBoard).toHaveBeenCalledTimes(1);
        expect(got.ok).toBe(true);
        // …and says so, rather than implying the agent was told.
        expect(got.delivered).toBe(false);
    });

    it('refuses a verdict for a post that is not on the board', () => {
        const d = deps();

        const got = reviewPost('ws-1', 'nope', { verdict: 'approved' }, d);

        expect(got.ok).toBe(false);
        expect(d.writeBoard).not.toHaveBeenCalled();
        expect(d.deliver).not.toHaveBeenCalled();
    });

    it('never delivers when the post recorded no terminal', () => {
        // An imported or hand-written post has nobody waiting on it. Guessing a
        // terminal would send someone else's board decision into an unrelated
        // agent's turn.
        const d = deps({ readBoard: () => [post({ terminalId: undefined })] });

        const got = reviewPost('ws-1', 'p1', { verdict: 'approved' }, d);

        expect(got.ok).toBe(true);
        expect(d.writeBoard).toHaveBeenCalledTimes(1);
        expect(d.deliver).not.toHaveBeenCalled();
    });
});
