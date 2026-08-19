import { describe, expect, it } from 'vitest';
import {
    parsePromptLibrary,
    removePrompt,
    serializePromptLibrary,
    upsertPrompt,
} from '../prompt-library';

/**
 * The Command Window's saved prompts (Tynn story #247), stored as JSON in one
 * setting.
 *
 * Everything here is defensive on the READ side for one reason: this string is
 * hand-editable and syncs between machines, so it WILL eventually be malformed or
 * half-written. An unusable Ctrl+K is worse than an empty prompt list, so a bad
 * library degrades to nothing rather than throwing on the path that opens the
 * palette.
 */
describe('reading a stored library', () => {
    it('reads back what was written', () => {
        const prompts = [{ id: 'a', label: 'Run tests', text: 'npm test' }];
        expect(parsePromptLibrary(serializePromptLibrary(prompts))).toEqual(prompts);
    });

    it('treats every kind of broken input as an empty library', () => {
        for (const raw of ['', '   ', 'not json', '{', 'null', '42', '"a string"', '{"a":1}']) {
            expect(parsePromptLibrary(raw), raw).toEqual([]);
        }
    });

    it('drops individual entries that are not usable, keeping the rest', () => {
        // One bad row must not cost the user their whole library. A prompt with no
        // LABEL cannot be found in the palette and one with no TEXT would send
        // nothing — both are unusable, so neither is offered.
        const raw = JSON.stringify([
            { id: 'ok', label: 'Good', text: 'do the thing' },
            { id: 'no-label', label: '', text: 'orphan' },
            { id: 'no-text', label: 'Empty', text: '   ' },
            'not an object',
            null,
            { label: 'no id', text: 'x' },
        ]);

        expect(parsePromptLibrary(raw)).toEqual([{ id: 'ok', label: 'Good', text: 'do the thing' }]);
    });

    it('ignores extra fields rather than rejecting the row', () => {
        // Forward compatibility: a newer Genie may add fields, and an older one
        // reading the same synced setting must not discard those prompts.
        const raw = JSON.stringify([{ id: 'a', label: 'L', text: 'T', icon: 'star', future: 1 }]);
        expect(parsePromptLibrary(raw)).toEqual([{ id: 'a', label: 'L', text: 'T' }]);
    });
});

describe('editing', () => {
    const base = [
        { id: 'a', label: 'First', text: '1' },
        { id: 'b', label: 'Second', text: '2' },
    ];

    it('updates in place, keeping position', () => {
        // Editing a prompt must not move it: the palette preserves order, so a
        // re-ordered library changes what Enter lands on.
        const next = upsertPrompt(base, { id: 'a', label: 'First edited', text: '1!' });
        expect(next.map((p) => p.id)).toEqual(['a', 'b']);
        expect(next[0]).toEqual({ id: 'a', label: 'First edited', text: '1!' });
    });

    it('appends a new prompt at the end', () => {
        const next = upsertPrompt(base, { id: 'c', label: 'Third', text: '3' });
        expect(next.map((p) => p.id)).toEqual(['a', 'b', 'c']);
    });

    it('removes by id and leaves the rest alone', () => {
        expect(removePrompt(base, 'a').map((p) => p.id)).toEqual(['b']);
        expect(removePrompt(base, 'nope').map((p) => p.id)).toEqual(['a', 'b']);
    });

    it('does not mutate the array it was given', () => {
        upsertPrompt(base, { id: 'z', label: 'Z', text: 'z' });
        removePrompt(base, 'a');
        expect(base.map((p) => p.id)).toEqual(['a', 'b']);
    });
});
