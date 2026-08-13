import { describe, expect, it } from 'vitest';
import {
    TYPING_QUIET_MS,
    inboxNoticeText,
    noteKeystrokes,
    shouldNotifyNow,
    type TypingState,
} from '../notify';

/**
 * IMMEDIATE inbox notices (owner, beta.248). Wake-on-DM only ever nudged a
 * PROVABLY IDLE agent, so a message sent to a working agent sat unseen until its
 * turn ended. The owner's call: tell the agent AS SOON AS the message lands —
 * a TUI queues text typed mid-turn, which is exactly how a human interjects.
 *
 * The one thing that must never happen is clobbering the HUMAN's own draft: if
 * they are typing at that terminal, or have text sitting in the box, the notice
 * waits. So the idle gate is replaced by a TYPING gate, not removed.
 */

const state = (over: Partial<TypingState> = {}): TypingState => ({
    pendingInput: false,
    lastUserInputAt: null,
    now: 1_000_000,
    ...over,
});

describe('shouldNotifyNow', () => {
    it('notifies immediately when the box is empty and nobody is typing', () => {
        // The point of the change: no idle requirement. A mid-turn agent gets the
        // notice queued, the way a human interjection is queued.
        expect(shouldNotifyNow(state())).toBe(true);
    });

    it('holds off while the human has text in the box', () => {
        // Injecting now would land in the middle of their half-written prompt.
        expect(shouldNotifyNow(state({ pendingInput: true }))).toBe(false);
    });

    it('holds off while the human is actively typing, even with an empty box', () => {
        // Mid-keystroke: they submitted a moment ago and are still going.
        expect(
            shouldNotifyNow(state({ lastUserInputAt: 1_000_000 - (TYPING_QUIET_MS - 1) })),
        ).toBe(false);
    });

    it('notifies once typing has gone quiet', () => {
        expect(
            shouldNotifyNow(state({ lastUserInputAt: 1_000_000 - (TYPING_QUIET_MS + 1) })),
        ).toBe(true);
    });

    it('still holds off for a stale keystroke if a draft is sitting there', () => {
        // Typed something an hour ago and walked away — the draft is still in the
        // box, so injecting still clobbers it.
        expect(shouldNotifyNow(state({ pendingInput: true, lastUserInputAt: 0 }))).toBe(false);
    });
});

describe('inboxNoticeText', () => {
    it('tells the agent a normal DM can wait until it is free', () => {
        const text = inboxNoticeText({ from: 'guardian', priority: 'normal' });
        expect(text).toContain('guardian');
        expect(text).toMatch(/not urgent|not important/i);
        expect(text).toMatch(/when you (are|'re) not busy/i);
        // It must be actionable — an agent told about a message with no way to
        // read it is just noise.
        expect(text).toContain('agentinbox');
    });

    it('tells the agent a HIGH-priority DM needs looking at now', () => {
        const text = inboxNoticeText({ from: 'guardian', priority: 'high' });
        expect(text).toMatch(/immediately|right away/i);
        expect(text).not.toMatch(/when you (are|'re) not busy/i);
        expect(text).toContain('agentinbox');
    });

    it('names the channel when the message was posted to one', () => {
        const text = inboxNoticeText({ from: 'guardian', channel: 'ops', priority: 'normal' });
        expect(text).toContain('ops');
        expect(text).toMatch(/channel/i);
    });

    it('is self-describing, so a turn it starts is obviously a Genie notice', () => {
        // Same rule as the wake nudge: never look like smuggled instructions.
        expect(inboxNoticeText({ from: 'x', priority: 'high' })).toMatch(/agentinbox/i);
    });
});

/**
 * Tracking the human's DRAFT from their keystrokes. Conservative by design: the
 * cost of thinking there IS a draft is a delayed notice (harmless — the message
 * is in the inbox either way); the cost of thinking there ISN'T is splicing
 * Genie's text into someone's half-written prompt and submitting it.
 */
describe('noteKeystrokes', () => {
    it('a printable keystroke starts a draft', () => {
        expect(noteKeystrokes(false, 'h')).toBe(true);
    });

    it('typing more keeps the draft', () => {
        expect(noteKeystrokes(true, 'ello')).toBe(true);
    });

    it('Enter submits, clearing the draft', () => {
        expect(noteKeystrokes(true, '\r')).toBe(false);
    });

    it('text typed AFTER the Enter in one chunk is a new draft', () => {
        // A paste, or a fast typist inside one IPC chunk.
        expect(noteKeystrokes(false, 'run it\rnext thing')).toBe(true);
    });

    it('a chunk ending in Enter leaves nothing pending', () => {
        expect(noteKeystrokes(false, 'run it\r')).toBe(false);
    });

    it('Ctrl-C abandons the line', () => {
        expect(noteKeystrokes(true, '\x03')).toBe(false);
    });

    it('Ctrl-U (kill line) clears the draft', () => {
        expect(noteKeystrokes(true, '\x15')).toBe(false);
    });

    it('arrow keys and other escape sequences do not START a draft on their own', () => {
        // Navigating history/panes is not composing a prompt; treating every
        // cursor key as a draft would silence notices for a browsing user.
        expect(noteKeystrokes(false, '\x1b[A')).toBe(false);
    });

    it('a bare control byte does not start a draft', () => {
        expect(noteKeystrokes(false, '\t')).toBe(false);
    });
});
