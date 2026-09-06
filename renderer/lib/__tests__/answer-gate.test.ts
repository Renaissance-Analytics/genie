import { describe, expect, it, vi } from 'vitest';
import {
    answerGate,
    answerFailureMessage,
    applyAnswerReport,
    submitAnswer,
} from '../answer-gate';

/**
 * Answering a host question from a window that does not hold control — genie#468.
 *
 * Control-gating (genie#467) stopped forwarding the MODAL and the chime to a
 * non-controlling driver, correctly: not interrupted is not the same as not
 * told, so the host's pending questions still appear in that driver's flyout.
 *
 * From there the driver could still press Answer. The host 423s the POST while
 * locked, and the client threw the rejection away — the button un-busied, the
 * question stayed exactly where it was, and NOTHING was said. That silence is
 * indistinguishable from success plus a slow refresh, so the natural read is "it
 * worked" and the natural next move is to press it again.
 *
 * Two halves, both required. A control you cannot use must not look usable — so
 * the button is disabled with the reason NAMED, not merely greyed. And because
 * the baton can move between the render and the click, a refusal that gets
 * through anyway has to become something the reviewer can see.
 */
describe('answerGate — who may answer from this window', () => {
    it('opens for a window that holds control', () => {
        // POSITIVE CONTROL for every refusal below: a gate that answered "no"
        // unconditionally would satisfy them all and break the product.
        expect(answerGate({ locked: false })).toEqual({ canAnswer: true, reason: null });
    });

    it('opens for a local window, which has no remote control state at all', () => {
        expect(answerGate(null).canAnswer).toBe(true);
        expect(answerGate(undefined).canAnswer).toBe(true);
    });

    it('closes while somebody else holds control', () => {
        expect(answerGate({ locked: true }).canAnswer).toBe(false);
    });

    it('NAMES the reason rather than leaving a dead button', () => {
        const reason = answerGate({ locked: true }).reason ?? '';
        // The two facts a person needs: why it is refused, and where the question
        // CAN be answered. A greyed control with neither is the same silence in
        // a different costume.
        expect(reason).toMatch(/control/i);
        expect(reason).toMatch(/host|there/i);
    });

    it('names the person holding the baton when the host says who', () => {
        // Several members can drive one workstation, so "the host" would blame
        // the machine for a peer's handoff.
        const reason = answerGate({ locked: true, holderName: 'Wish Born', holderEmoji: '🦊' })
            .reason ?? '';
        expect(reason).toContain('Wish Born');
        expect(reason).toContain('🦊');
    });

    it('falls back to the host when the holder is unknown (an older host)', () => {
        const reason = answerGate({ locked: true, holderName: null, holderEmoji: null })
            .reason ?? '';
        expect(reason).toMatch(/host/i);
        expect(reason).not.toContain('null');
    });
});

/**
 * The second half: a refusal that arrives ANYWAY must be visible.
 *
 * The baton moves precisely when a question is pending — the host owner grabs it
 * because they want to answer that question themselves — so the window between
 * "the gate was open when this rendered" and "the POST arrived" is exactly the
 * window that matters.
 */
describe('submitAnswer — no outcome is discarded', () => {
    it('reports a delivered answer', () => {
        // POSITIVE CONTROL. Both failures below are also true of a submit that
        // can no longer deliver anything at all.
        return expect(submitAnswer(() => Promise.resolve(true))).resolves.toEqual({
            kind: 'answered',
        });
    });

    it('surfaces the host refusing a locked answer instead of swallowing it', async () => {
        const r = await submitAnswer(() =>
            Promise.reject(new Error('The host has remote control locked.')),
        );
        expect(r.kind).toBe('refused');
        expect(r.kind !== 'answered' && r.message).toMatch(/control/i);
    });

    it('recognises the lock however the transport spells it', async () => {
        // Two spellings reach the renderer for the same 423: main's remoteRequest
        // throws a sentence, the relay path throws `HTTP 423`. An Error does not
        // survive IPC with its type, so its MESSAGE is the only channel there is.
        const viaStatus = await submitAnswer(() => Promise.reject(new Error('HTTP 423')));
        expect(viaStatus.kind).toBe('refused');
        expect(viaStatus.kind !== 'answered' && viaStatus.message).toMatch(/control/i);
    });

    it('does not report an answer the host declined to use as sent', async () => {
        // `answered:false` is the benign race — the desktop or another driver got
        // there first. Benign is not the same as invisible: the reviewer typed an
        // answer and it was not the one that counted.
        const r = await submitAnswer(() => Promise.resolve(false));
        expect(r.kind).toBe('already-answered');
        expect(r.kind !== 'answered' && r.message).toMatch(/already/i);
    });

    it('says something for a failure it has no special name for', async () => {
        const r = await submitAnswer(() => Promise.reject(new Error('socket hang up')));
        expect(r.kind).toBe('refused');
        expect(r.kind !== 'answered' && r.message).toContain('socket hang up');
    });

    it('calls the sender exactly once', async () => {
        const send = vi.fn().mockResolvedValue(true);
        await submitAnswer(send);
        expect(send).toHaveBeenCalledTimes(1);
    });
});

describe('answerFailureMessage', () => {
    it('tells a locked driver WHERE the question can be answered', () => {
        const said = answerFailureMessage(new Error('The host has remote control locked.'));
        expect(said).toMatch(/host/i);
        // …and that nothing was lost — the question is still there to answer.
        expect(said).toMatch(/still/i);
    });

    it('names an expired session as one, not as a lock', () => {
        const said = answerFailureMessage(new Error('HTTP 401'));
        expect(said).toMatch(/reconnect/i);
        expect(said).not.toMatch(/control/i);
    });
});

/**
 * The last place a refusal can be dropped: what the CARD does with the report.
 *
 * Classifying the outcome is worth nothing if the component then throws the
 * classification away, which is precisely the bug — the old submit awaited the
 * call, ignored both the rejection and the `false`, and un-busied the button.
 * So the effects are decided here, where they can be asserted without a DOM.
 */
describe('applyAnswerReport — every outcome reaches the reviewer', () => {
    const sinks = () => {
        const notices: (string | null)[] = [];
        const refreshes: number[] = [];
        return {
            notices,
            refreshes,
            notice: (m: string | null) => notices.push(m),
            refresh: () => refreshes.push(1),
        };
    };

    it('an accepted answer just re-reads — the card leaving IS the confirmation', () => {
        const s = sinks();
        applyAnswerReport({ kind: 'answered' }, s);
        expect(s.refreshes).toHaveLength(1);
        // No notice: a question that visibly disappears has already said it.
        expect(s.notices.filter(Boolean)).toHaveLength(0);
    });

    it('an already-answered race is SAID, not merely swept up by the refresh', () => {
        const s = sinks();
        applyAnswerReport({ kind: 'already-answered', message: 'already' }, s);
        expect(s.notices).toContain('already');
        // …and still re-reads, because the question is genuinely resolved.
        expect(s.refreshes).toHaveLength(1);
    });

    it('a refusal is SAID and the question is left exactly where it was', () => {
        const s = sinks();
        applyAnswerReport({ kind: 'refused', message: 'the host has control' }, s);
        expect(s.notices).toContain('the host has control');
        // Re-reading here would make the still-pending question flicker as if
        // something had happened. Nothing did — that is the whole message.
        expect(s.refreshes).toHaveLength(0);
    });
});
