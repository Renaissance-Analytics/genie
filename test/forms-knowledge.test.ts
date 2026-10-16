import { describe, expect, it } from 'vitest';
import { knowledgeFormDefaults, validateKnowledgeForm } from '../src/core/forms.js';

/**
 * THE FORM BEHIND "Add a memory" — a pure model. Defaults: an empty title and body, class
 * `knowledge`, scope this machine unless a workspace was named. Validation names the one thing a
 * memory cannot do without: a title.
 */

describe('Add a memory', () => {
    it('defaults to an empty note of class knowledge, scoped to the machine, or to the named workspace', () => {
        expect(knowledgeFormDefaults({})).toEqual({ title: '', body: '', class: 'knowledge', scope: { kind: 'system' } });
        expect(knowledgeFormDefaults({ workspaceId: 'tynn' })).toEqual({ title: '', body: '', class: 'knowledge', scope: { kind: 'workspace', id: 'tynn' } });
    });

    it('a memory needs a title; whitespace is not one', () => {
        expect(validateKnowledgeForm({ title: '  ', body: 'x', class: 'knowledge', scope: { kind: 'system' } })).toEqual([{ field: 'title', message: 'A memory needs a title.' }]);
        expect(validateKnowledgeForm({ title: 'Caddy replace breaks h2', body: '', class: 'procedural', scope: { kind: 'system' } })).toEqual([]);
    });
});
