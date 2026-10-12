import { describe, expect, it } from 'vitest';
import { agentViewAction, approvalChoice, stepRow, toggleThoughts } from '../src/core/keys.js';
import type { TimedEvent } from '../src/core/stream-view.js';

/**
 * §4.2's key map, the rest of it: `j`/`k` stream cursor · `↵` open/close Inspector · `Esc`
 * closes the Inspector FIRST and only then leaves for the Deck · `t` toggles the Thought lane
 * (the one letter; no other lane gets one) · `a`/`d` allow/deny the parked approval.
 *
 * Bindings are proven as a COUNT over the whole alphabet so an accidental binding cannot
 * appear; the effects of each are pure helpers proven without a window.
 */

const press = (key: string) => agentViewAction({ key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, typing: false });

describe('the bindings', () => {
    it('maps exactly the keys §4.2 names, and nothing else — COUNTED over the alphabet', () => {
        const bound: Record<string, string> = {};
        for (const k of 'abcdefghijklmnopqrstuvwxyz') {
            const a = press(k);
            if (a) bound[k] = a;
        }
        expect(bound).toEqual({ a: 'allow', d: 'deny', e: 'next-edit', j: 'next-row', k: 'prev-row', l: 'toggle-lanes', t: 'toggle-thoughts' });
    });

    it('binds Enter and Escape', () => {
        expect(press('Enter')).toBe('toggle-inspector');
        expect(press('Escape')).toBe('escape');
    });

    it('upper case is the same key', () => {
        expect(press('J')).toBe('next-row');
        expect(press('A')).toBe('allow');
    });

    it('every binding is dead while typing — COUNTED', () => {
        const keys = ['a', 'd', 'e', 'j', 'k', 'l', 't', 'Enter'];
        const alive = keys.filter((key) =>
            agentViewAction({ key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, typing: true }) !== null);
        expect(alive).toEqual([]);
    });

    it('Escape is the one key that still acts while typing — it leaves the field, nothing more', () => {
        // Esc in a composer is "stop typing", which is a request the rest of the map must not
        // swallow: the handler receives `escape` and, with a typing target, blurs rather than
        // navigates. The decision is still the handler's; the map only says the key counts.
        expect(agentViewAction({ key: 'Escape', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, typing: true })).toBe('escape');
    });
});

describe('⌘⇧T — Take Over (§4.2)', () => {
    // A CHORD, not a letter: it carries a modifier on purpose, so the typing rule does not
    // apply to it — the composer must not swallow the one shortcut that opens a window.
    const chord = (key: string, over: Partial<{ ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean; typing: boolean }> = {}) =>
        agentViewAction({ key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, typing: false, ...over });

    it('is Take Over with Meta (macOS) or Ctrl (elsewhere), in either case of the letter', () => {
        expect(chord('T', { metaKey: true, shiftKey: true })).toBe('take-over');
        expect(chord('t', { metaKey: true, shiftKey: true })).toBe('take-over');
        expect(chord('T', { ctrlKey: true, shiftKey: true })).toBe('take-over');
    });

    it('still acts while typing — a chord is not an unmodified letter', () => {
        expect(chord('T', { metaKey: true, shiftKey: true, typing: true })).toBe('take-over');
    });

    it('needs BOTH halves — ⌘T, ⇧T and ⌘⇧⌥T are not Take Over (the positive control for the chord)', () => {
        // ⌘T alone belongs to the OS/browser (new tab) and answers null like every other
        // modified letter; ⇧T alone is still the Thought-lane toggle; Alt on top is nothing.
        expect(chord('T', { metaKey: true })).toBeNull();
        expect(chord('T', { ctrlKey: true })).toBeNull();
        expect(chord('T', { shiftKey: true })).toBe('toggle-thoughts');
        expect(chord('T', { metaKey: true, shiftKey: true, altKey: true })).toBeNull();
    });

    it('binds exactly ONE letter under ⌘⇧ — COUNTED over the alphabet', () => {
        const bound: Record<string, string> = {};
        for (const k of 'abcdefghijklmnopqrstuvwxyz') {
            const a = chord(k.toUpperCase(), { metaKey: true, shiftKey: true });
            if (a) bound[k] = a;
        }
        expect(bound).toEqual({ t: 'take-over' });
    });
});

describe('the stream cursor', () => {
    const ids = ['r1', 'r2', 'r3'];

    it('j moves down, k moves up', () => {
        expect(stepRow(ids, 'r1', 'next')).toBe('r2');
        expect(stepRow(ids, 'r2', 'prev')).toBe('r1');
    });

    it('from nothing selected, j is the first row and k is the last', () => {
        expect(stepRow(ids, null, 'next')).toBe('r1');
        expect(stepRow(ids, null, 'prev')).toBe('r3');
    });

    it('stops at the ends rather than wrapping — a cursor that teleports is disorienting', () => {
        // Different from `E`, which wraps: `E` is "find me the next one", a search; `j` is a
        // cursor, and a cursor at the end of a list stays there.
        expect(stepRow(ids, 'r3', 'next')).toBe('r3');
        expect(stepRow(ids, 'r1', 'prev')).toBe('r1');
    });

    it('is null on an empty stream', () => {
        expect(stepRow([], null, 'next')).toBeNull();
    });

    it('a selection that is no longer visible starts over from the edge', () => {
        // The selected row was filtered out by a lane or range change. Stepping from it would
        // be stepping from nowhere; the cursor re-enters at the end the key points at.
        expect(stepRow(ids, 'gone', 'next')).toBe('r1');
        expect(stepRow(ids, 'gone', 'prev')).toBe('r3');
    });
});

describe('t — the Thought lane', () => {
    it('from not filtering, hides thoughts — the common wish', () => {
        expect(toggleThoughts(null)).toEqual(['messages', 'tools', 'edits']);
    });

    it('from thoughts hidden, shows them again — and all four is recorded as not filtering', () => {
        expect(toggleThoughts(['messages', 'tools', 'edits'])).toBeNull();
    });

    it('from a narrower selection, adds or removes only thoughts', () => {
        expect(toggleThoughts(['edits'])).toEqual(['edits', 'thoughts']);
        expect(toggleThoughts(['edits', 'thoughts'])).toEqual(['edits']);
    });

    it('from filtering to nothing, shows thoughts alone', () => {
        expect(toggleThoughts([])).toEqual(['thoughts']);
    });
});

describe('a / d — answering the parked approval', () => {
    const approval = {
        question: 'php artisan migrate --force',
        options: [
            { id: 'codex-accept', label: 'Allow', tone: 'ok' as const },
            { id: 'codex-accept-session', label: 'Allow for session', tone: 'ok' as const },
            { id: 'codex-decline', label: 'Decline', tone: 'bad' as const },
            { id: 'codex-cancel', label: 'Cancel', tone: 'bad' as const },
        ],
    };

    it('a is the FIRST allow option, d the FIRST deny — the least-committal of each', () => {
        expect(approvalChoice(approval, 'allow')).toBe('codex-accept');
        expect(approvalChoice(approval, 'deny')).toBe('codex-decline');
    });

    it('is null with no approval parked — the key does nothing, rather than something', () => {
        expect(approvalChoice(null, 'allow')).toBeNull();
    });

    it('is null when no option carries that tone — never a neutral option by accident', () => {
        // A request whose options are all `neutral` (unrecognised kinds) cannot be answered by
        // a single letter: the reader has to read the labels. Guessing would send the provider
        // a decision nobody made.
        const neutral = { question: 'x', options: [{ id: 'o1', label: 'Maybe', tone: 'neutral' as const }] };
        expect(approvalChoice(neutral, 'allow')).toBeNull();
        expect(approvalChoice(neutral, 'deny')).toBeNull();
    });
});

// The helpers take ids, not rows, so the pure tests above need no event fixtures; this is the
// one place a row shape is touched, to assert the id projection the handler relies on.
const _rowShape: TimedEvent = { id: 'r', at: null, event: { kind: 'message', speaker: 'you', peerName: null, text: '' } };
void _rowShape;
