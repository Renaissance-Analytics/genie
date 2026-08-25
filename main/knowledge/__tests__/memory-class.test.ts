import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { runMigrations } from '../../db';
import { KnowledgeStore } from '../store';
import { MEMORY_CLASSES, type MemoryClass } from '../types';

/**
 * The Knowledge Graph's four MEMORY CLASSES (Tynn #250).
 *
 * Genie's knowledge store answers one question today — "find me a node matching
 * this text". The agentic-resources research is emphatic that this collapses four
 * genuinely different retrieval problems into one, and that doing so is a mistake
 * you pay for later:
 *
 *   profile     — what does the user prefer / what is true of them?
 *   episodic    — what happened, and when?
 *   procedural  — what was learned from doing this before?
 *   knowledge   — where is this in the documents?
 *
 * "What does Wish prefer?" and "find the section about X in 8,000 documents" are
 * not the same query with a different string, and an agent that cannot say which
 * one it is asking gets the other one's answers.
 *
 * The change is deliberately ADDITIVE: one graph, `[[wikilinks]]` still cross
 * classes, retrieval that knows which problem it is solving. Not a vector store.
 */

function store(): KnowledgeStore {
    const db = new Database(':memory:');
    runMigrations(db);
    return new KnowledgeStore(db);
}

describe('a node carries its memory class', () => {
    it('keeps the class it was written with', () => {
        const s = store();
        const node = s.add({
            source: 'agent',
            title: 'Prefers Bash over PowerShell',
            body: 'Always use the Bash tool.',
            class: 'profile',
        });

        expect(node.class).toBe('profile');
        expect(s.get(node.id)?.class).toBe('profile');
    });

    it('defaults to `knowledge` when none is given', () => {
        // The class every pre-existing node is, and the safest default: a note
        // filed as knowledge is findable, whereas one mis-filed as `profile`
        // would start answering "what does the user prefer?".
        const s = store();
        expect(s.add({ source: 'agent', title: 'A doc', body: 'text' }).class).toBe('knowledge');
    });

    it('refuses an unrecognised class rather than storing it', () => {
        const s = store();
        expect(() =>
            s.add({ source: 'agent', title: 'x', body: 'y', class: 'feelings' as unknown as MemoryClass }),
        ).toThrow(/class/i);
    });

    it('offers exactly the four classes the research names', () => {
        expect([...MEMORY_CLASSES].sort()).toEqual([
            'episodic',
            'knowledge',
            'procedural',
            'profile',
        ]);
    });
});

describe('search knows which question it is answering', () => {
    const seeded = () => {
        const s = store();
        s.add({ source: 'agent', title: 'Prefers Bash', body: 'shell preference', class: 'profile' });
        s.add({ source: 'agent', title: 'Shipped beta.264', body: 'shell of a release', class: 'episodic' });
        s.add({ source: 'agent', title: 'How to fix a shell hang', body: 'shell recipe', class: 'procedural' });
        s.add({ source: 'agent', title: 'Shell scripting guide', body: 'shell docs', class: 'knowledge' });
        return s;
    };

    it('returns every class when none is asked for — nothing regresses', () => {
        // The existing call site passes no class and must keep working exactly as
        // it did, or every current caller silently starts finding less.
        expect(seeded().search({ query: 'shell' })).toHaveLength(4);
    });

    it('narrows to ONE class when asked', () => {
        const hits = seeded().search({ query: 'shell', class: 'procedural' });

        expect(hits).toHaveLength(1);
        expect(hits[0]?.title).toBe('How to fix a shell hang');
    });

    it('does not leak another class into a scoped search', () => {
        // The whole point. A "what does the user prefer?" query that returns a
        // release note has answered a different question and looks like a wrong
        // memory rather than a wrong scope.
        for (const cls of MEMORY_CLASSES) {
            const hits = seeded().search({ query: 'shell', class: cls });

            // The positive control. `every` is vacuously true on an empty array,
            // so "nothing leaked" would also pass against a search that returned
            // nothing at all — a corpse. Each class has exactly one match here.
            expect(hits, `${cls} found nothing`).toHaveLength(1);
            expect(hits.every((h) => h.class === cls), `${cls} leaked`).toBe(true);
        }
    });

    it('finds nothing rather than everything when a class has no match', () => {
        expect(seeded().search({ query: 'nonexistent', class: 'profile' })).toEqual([]);
    });
});

describe('list knows which question it is answering', () => {
    /** Four memories that share no searchable word, one per class. */
    const seeded = () => {
        const s = store();
        s.add({ source: 'agent', title: 'Prefers Bash', body: 'a preference', class: 'profile' });
        s.add({ source: 'agent', title: 'Shipped beta.264', body: 'a release', class: 'episodic' });
        s.add({ source: 'agent', title: 'Fixing a hang', body: 'a recipe', class: 'procedural' });
        s.add({ source: 'agent', title: 'Caddy guide', body: 'a document', class: 'knowledge' });
        return s;
    };

    it('lists every class when none is asked for — nothing regresses', () => {
        expect(seeded().list()).toHaveLength(4);
    });

    it('narrows to ONE class when asked', () => {
        // "What happened recently?" is episodic memory's natural question, and it
        // is a LIST ordered by recency — not a keyword search, which would need a
        // query string the caller does not have.
        const nodes = seeded().list({ class: 'episodic' });

        expect(nodes).toHaveLength(1);
        expect(nodes[0]?.title).toBe('Shipped beta.264');
    });

    it('does not leak another class into a scoped list', () => {
        for (const cls of MEMORY_CLASSES) {
            const nodes = seeded().list({ class: cls });

            // Positive control — see the scoped-search test above.
            expect(nodes, `${cls} found nothing`).toHaveLength(1);
            expect(nodes.every((n) => n.class === cls), `${cls} leaked`).toBe(true);
        }
    });

    it('narrows by class AND tag together', () => {
        const s = store();
        s.add({ source: 'agent', title: 'Old release', body: 'x', tags: ['genie'], class: 'episodic' });
        s.add({ source: 'agent', title: 'Old doc', body: 'x', tags: ['genie'], class: 'knowledge' });
        s.add({ source: 'agent', title: 'Untagged release', body: 'x', class: 'episodic' });

        const nodes = s.list({ class: 'episodic', tag: 'genie' });

        expect(nodes.map((n) => n.title)).toEqual(['Old release']);
    });
});

describe('the graph is still one graph', () => {
    it('links ACROSS classes — a habit can cite a document', () => {
        // Splitting retrieval must not split the graph. What was learned
        // (procedural) routinely points at where it is written down (knowledge).
        const s = store();
        const doc = s.add({ source: 'agent', title: 'Caddy config', body: 'reference', class: 'knowledge' });
        const how = s.add({
            source: 'agent',
            title: 'Fixing a blank site',
            body: 'see [[Caddy config]]',
            class: 'procedural',
        });

        expect(s.get(how.id)?.links).toContain(doc.id);
    });
});
