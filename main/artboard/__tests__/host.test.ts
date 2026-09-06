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
        deliver: vi.fn().mockReturnValue('delivered'),
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
        const d = deps({ deliver: vi.fn().mockReturnValue('no-agent') });

        const got = reviewPost('ws-1', 'p1', { verdict: 'rejected' }, d);

        expect(d.writeBoard).toHaveBeenCalledTimes(1);
        expect(got.ok).toBe(true);
        // …and says so, rather than implying the agent was told.
        expect(got.ok && got.delivery).not.toBe('delivered');
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

/**
 * WHY a verdict was not delivered — genie#462.
 *
 * `reviewPost` used to return one boolean, `delivered`, and the panel turned
 * that single bit into a specific, confident cause: "the agent that posted it is
 * no longer running". It had not checked that, and for the whole life of the
 * feature it was WRONG — before genie#456 no post stored a `terminalId` at all,
 * so every verdict was undelivered and every one of them blamed an agent that
 * was alive and waiting. That sentence is what sent the owner hunting an
 * agent-lifecycle problem that did not exist.
 *
 * Three different situations reach the same `false`, and they call for three
 * different things from the reader:
 *
 *  - `no-agent`   — the terminal has no agent identity any more. The verdict is
 *                   on the board; nobody is coming back for it.
 *  - `refused`    — the broker declined the message. The agent may well be alive.
 *  - `no-terminal`— the post recorded no terminal. After #456 this should be
 *                   impossible, so it is a REGRESSION to name out loud, not
 *                   something to disguise as a dead agent.
 *
 * So the host reports which one, and the panel says the true thing.
 */
describe('reviewPost names WHY the verdict was not delivered (genie#462)', () => {
    const deps = (over: Record<string, unknown> = {}) => ({
        readBoard: () => [post()],
        writeBoard: vi.fn(),
        deliver: vi.fn().mockReturnValue('delivered'),
        now: () => '2026-08-26T12:00:00.000Z',
        ...over,
    });

    it('reports a delivery that landed', () => {
        // POSITIVE CONTROL for the three failures below: the same call, the same
        // board, and the outcome is genuinely reachable — so a `delivery` that is
        // never 'delivered' would fail here rather than pass everywhere.
        const got = reviewPost('ws-1', 'p1', { verdict: 'approved' }, deps());
        expect(got.ok && got.delivery).toBe('delivered');
    });

    it('distinguishes a terminal with no agent from a broker refusal', () => {
        const gone = reviewPost(
            'ws-1',
            'p1',
            { verdict: 'approved' },
            deps({ deliver: vi.fn().mockReturnValue('no-agent') }),
        );
        const refused = reviewPost(
            'ws-1',
            'p1',
            { verdict: 'approved' },
            deps({ deliver: vi.fn().mockReturnValue('refused') }),
        );

        expect(gone.ok && gone.delivery).toBe('no-agent');
        expect(refused.ok && refused.delivery).toBe('refused');
    });

    it('reports a post with no terminal as its own case, not as a dead agent', () => {
        // The state that made the original message a lie. Naming it separately is
        // the point: if this ever comes back it is a #456 regression, and calling
        // it "the agent is no longer running" would hide it exactly as before.
        const got = reviewPost(
            'ws-1',
            'p1',
            { verdict: 'approved' },
            deps({ readBoard: () => [post({ terminalId: undefined })] }),
        );

        expect(got.ok && got.delivery).toBe('no-terminal');
    });

    it('records the verdict whatever the delivery outcome', () => {
        for (const outcome of ['delivered', 'no-agent', 'refused'] as const) {
            const d = deps({ deliver: vi.fn().mockReturnValue(outcome) });
            reviewPost('ws-1', 'p1', { verdict: 'rejected' }, d);
            expect(d.writeBoard, `${outcome} lost the verdict`).toHaveBeenCalledTimes(1);
        }
    });
});
