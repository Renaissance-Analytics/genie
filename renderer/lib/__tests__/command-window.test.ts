import { describe, expect, it } from 'vitest';
import {
    COMMAND_PREFIXES,
    filterCommandItems,
    parseCommandQuery,
    type CommandItem,
} from '../command-window';

/**
 * The Command Window's judgement (Tynn story #247) — everything except the pixels.
 *
 * The palette itself is Fancy's `Command` (react-fancy already ships it, and
 * Genie already depends on it), so this file owns only what Fancy cannot know:
 * which of Genie's things are offered, and how a typed query narrows them.
 *
 * The type-ahead PREFIXES are the part worth testing hard. `p> ` means "prompts
 * only" — but a bare `p` is someone starting to type "php", and swallowing that
 * as a filter would make the palette feel like it is fighting you. So a prefix is
 * only a prefix when it is complete.
 */

const ITEMS: CommandItem[] = [
    { id: 'ws-1', category: 'workspace', label: 'Tynn.ai' },
    { id: 'ws-2', category: 'workspace', label: 'Prism Sandbox' },
    { id: 'term-1', category: 'terminal', label: 'claude — repos/tynn' },
    { id: 'prompt-1', category: 'prompt', label: 'Run the test suite' },
    { id: 'prompt-2', category: 'prompt', label: 'Summarise what you changed' },
    { id: 'panel-1', category: 'panel', label: 'Site Manager' },
];

describe('parsing a typed query', () => {
    it('reads a complete prefix as a category filter', () => {
        expect(parseCommandQuery('p> test')).toEqual({ category: 'prompt', text: 'test' });
        expect(parseCommandQuery('w> tynn')).toEqual({ category: 'workspace', text: 'tynn' });
    });

    it('accepts a prefix with nothing after it yet', () => {
        // `p>` alone means "show me every prompt" — the browse case, and the
        // moment right before typing a filter.
        expect(parseCommandQuery('p>')).toEqual({ category: 'prompt', text: '' });
        expect(parseCommandQuery('p> ')).toEqual({ category: 'prompt', text: '' });
    });

    it('does NOT treat a bare letter as a prefix', () => {
        // Someone typing "php" starts with "p". Eating that would make the
        // palette feel like it is fighting the user.
        expect(parseCommandQuery('p')).toEqual({ category: null, text: 'p' });
        expect(parseCommandQuery('php')).toEqual({ category: null, text: 'php' });
    });

    it('ignores an unknown prefix rather than filtering everything away', () => {
        // `z>` matches no category. Silently returning nothing would read as a
        // broken palette; treating it as literal text at least searches.
        expect(parseCommandQuery('z> thing')).toEqual({ category: null, text: 'z> thing' });
    });

    it('is case-insensitive and tolerates surrounding space', () => {
        expect(parseCommandQuery('  W> Tynn ')).toEqual({ category: 'workspace', text: 'Tynn' });
    });

    it('has a prefix for every category it offers', () => {
        // A category with no prefix is unreachable by keyboard, which defeats a
        // keyboard-first palette.
        const categories = new Set(ITEMS.map((i) => i.category));
        for (const category of categories) {
            expect(Object.values(COMMAND_PREFIXES)).toContain(category);
        }
    });
});

describe('filtering', () => {
    it('offers everything for an empty query', () => {
        expect(filterCommandItems(ITEMS, parseCommandQuery('')).length).toBe(ITEMS.length);
    });

    it('narrows to one category on a prefix, without needing any text', () => {
        const shown = filterCommandItems(ITEMS, parseCommandQuery('p>'));
        expect(shown.map((i) => i.id)).toEqual(['prompt-1', 'prompt-2']);
    });

    it('matches text case-insensitively, anywhere in the label', () => {
        const shown = filterCommandItems(ITEMS, parseCommandQuery('sandbox'));
        expect(shown.map((i) => i.id)).toEqual(['ws-2']);
    });

    it('combines a category with its text', () => {
        const shown = filterCommandItems(ITEMS, parseCommandQuery('p> summar'));
        expect(shown.map((i) => i.id)).toEqual(['prompt-2']);
    });

    it('searches across categories when no prefix is given', () => {
        // "tynn" is a workspace AND part of a terminal's cwd. A keyboard-first
        // palette should surface both rather than pick one.
        const shown = filterCommandItems(ITEMS, parseCommandQuery('tynn'));
        expect(shown.map((i) => i.id)).toEqual(['ws-1', 'term-1']);
    });

    it('returns nothing findable rather than everything when text matches none', () => {
        expect(filterCommandItems(ITEMS, parseCommandQuery('zzzz'))).toEqual([]);
    });

    it('keeps the given order, so the list does not reshuffle as you type', () => {
        const shown = filterCommandItems(ITEMS, parseCommandQuery(''));
        expect(shown.map((i) => i.id)).toEqual(ITEMS.map((i) => i.id));
    });
});
