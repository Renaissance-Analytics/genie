import { describe, expect, it } from 'vitest';
import { agentViewAction, isTypingTarget } from '../src/core/keys.js';

/**
 * KEYS — §4.2's single-letter shortcuts, and the one rule above all of them:
 *
 * > **An unmodified letter must never act while a human is typing.**
 *
 * A composer, a search box, a contenteditable: a key pressed there is text. The guard is a pure
 * function of the event's target so it can be proven here, and every binding goes through it.
 */

type Target = { tagName: string; isContentEditable?: boolean };

describe('the typing guard', () => {
    it('counts every text-entry target, COUNTED', () => {
        // Every shape a letter could be text in. One missed means a shortcut fires mid-word.
        const typing: Target[] = [
            { tagName: 'INPUT' },
            { tagName: 'TEXTAREA' },
            { tagName: 'SELECT' },
            { tagName: 'DIV', isContentEditable: true },
            { tagName: 'input' }, // case must not matter
        ];
        const missed = typing.filter((t) => !isTypingTarget(t));
        expect(missed).toEqual([]);
    });

    it('does NOT count ordinary targets — the positive control', () => {
        // Without this the guard could return true for everything and every shortcut would be
        // silently dead, which reads exactly like "the keys were never built".
        const ordinary: Target[] = [{ tagName: 'DIV' }, { tagName: 'BUTTON' }, { tagName: 'BODY' }, { tagName: 'A' }];
        const wrongly = ordinary.filter((t) => isTypingTarget(t));
        expect(wrongly).toEqual([]);
    });

    it('treats a missing target as not typing', () => {
        expect(isTypingTarget(null)).toBe(false);
    });
});

describe('what a key means in the Agent view', () => {
    const press = (key: string, over: Partial<{ ctrlKey: boolean; metaKey: boolean; altKey: boolean; typing: boolean }> = {}) =>
        agentViewAction({ key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, typing: false, ...over });

    it('E is the next edit, in either case', () => {
        expect(press('e')).toBe('next-edit');
        expect(press('E')).toBe('next-edit');
    });

    it('does NOTHING while typing', () => {
        expect(press('e', { typing: true })).toBeNull();
    });

    it('does NOTHING with a modifier — Ctrl+E belongs to the OS and the browser', () => {
        expect(press('e', { ctrlKey: true })).toBeNull();
        expect(press('e', { metaKey: true })).toBeNull();
        expect(press('e', { altKey: true })).toBeNull();
    });

    it('is null for a key it does not bind — never a guess', () => {
        // COUNTED over keys §4.2 gives to other surfaces or to nothing. Unbound means null, so
        // a future binding is a deliberate addition rather than an accident of fall-through.
        // (`a`, `d`, `Enter`, `Escape`, `l` and `/` left this list when they were bound, on purpose, with
        // their own tests — the full map is counted in `agent-keys.test.ts`.)
        const unbound = ['q', 'z', ' ', '1', 'Tab', 'ArrowDown'];
        const bound = unbound.map((k) => press(k)).filter((a) => a !== null);
        expect(bound).toEqual([]);
    });
});
