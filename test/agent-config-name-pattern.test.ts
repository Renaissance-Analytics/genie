import { describe, expect, it } from 'vitest';
import { frontmatterMove } from '../src/core/agent-config.js';

// An agent's name is matched literally when its persona's "You are <name>." line is dropped: a name with pattern
// characters neither breaks the read nor matches some other name.
describe('frontmatterMove reads the name literally', () => {
    it('a name with pattern characters has its own "You are" line dropped', () => {
        const text = '---\ntuis: [claude]\n---\nYou are a.b+c (x). Keeps the books.\n';
        expect(frontmatterMove(text, 'a.b+c (x)')?.config.purpose).toBe('Keeps the books.');
    });

    it('a pattern-like name does not match a different name (CONTROL)', () => {
        const text = '---\ntuis: [claude]\n---\nYou are axb. Keeps the books.\n';
        expect(frontmatterMove(text, 'a.b')?.config.purpose).toBe('You are axb. Keeps the books.');
    });

    it('a name ending in a backslash does not throw', () => {
        const text = '---\ntuis: [claude]\n---\nYou are odd\\. Keeps the books.\n';
        expect(() => frontmatterMove(text, 'odd\\')).not.toThrow();
    });
});
