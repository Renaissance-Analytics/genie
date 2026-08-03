import { describe, expect, it } from 'vitest';
import {
    convertFmValue,
    frontMatterPill,
    joinFrontMatter,
    normalizeFrontMatter,
    parseFrontMatter,
    parseFrontMatterFields,
    removeFrontMatterField,
    renameFrontMatterField,
    setFrontMatterField,
    supportsFrontMatter,
    type FmField,
} from '../front-matter';

/**
 * The front-matter seam: split a markdown file into its YAML block and its
 * body, edit the block as key→value pairs, put it back.
 *
 * The load-bearing promise is the ROUND TRIP — `joinFrontMatter` handed back
 * exactly what `parseFrontMatter` produced must return the original bytes.
 * Genie feeds the BODY to a WYSIWYG editor; if the split/join drifted by a
 * newline, opening a file and saving it would rewrite the user's front matter.
 */

describe('supportsFrontMatter', () => {
    it('claims the markdown text types and NOT .docx', () => {
        expect(supportsFrontMatter('notes.md')).toBe(true);
        expect(supportsFrontMatter('notes.markdown')).toBe(true);
        expect(supportsFrontMatter('.cursor/rules/x.mdc')).toBe(true);
        expect(supportsFrontMatter('REPORT.MD')).toBe(true);
        expect(supportsFrontMatter('report.docx')).toBe(false);
        expect(supportsFrontMatter('notes.txt')).toBe(false);
    });
});

describe('parseFrontMatter', () => {
    it('splits a leading --- block off the body', () => {
        const p = parseFrontMatter('---\ntitle: Hi\n---\n# Body\n');
        expect(p.frontMatter).toBe('title: Hi');
        expect(p.body).toBe('# Body\n');
        expect(p.eol).toBe('\n');
    });

    it('reports no front matter when the file has none', () => {
        const p = parseFrontMatter('# Body\n\ntext\n');
        expect(p.frontMatter).toBeNull();
        expect(p.body).toBe('# Body\n\ntext\n');
    });

    it('reads an EMPTY block as an empty string, not as absent', () => {
        const p = parseFrontMatter('---\n---\nbody\n');
        expect(p.frontMatter).toBe('');
        expect(p.body).toBe('body\n');
    });

    it('keeps CRLF out of the YAML it hands back', () => {
        const p = parseFrontMatter('---\r\ntitle: Hi\r\nid: 4\r\n---\r\n# Body\r\n');
        expect(p.frontMatter).toBe('title: Hi\nid: 4');
        expect(p.body).toBe('# Body\r\n');
        expect(p.eol).toBe('\r\n');
    });

    it('ignores a --- that is not on line 1 (a horizontal rule mid-document)', () => {
        const text = '# Title\n\n---\n\nnot front matter\n\n---\n';
        expect(parseFrontMatter(text).frontMatter).toBeNull();
        expect(parseFrontMatter(text).body).toBe(text);
    });

    it('ignores a leading --- that is never closed (a setext rule, not a block)', () => {
        const text = '---\njust a document that opens with a rule\n';
        expect(parseFrontMatter(text).frontMatter).toBeNull();
        expect(parseFrontMatter(text).body).toBe(text);
    });

    it('ignores a blank line before the opening fence', () => {
        expect(parseFrontMatter('\n---\ntitle: Hi\n---\n').frontMatter).toBeNull();
    });

    it('keeps a BOM out of the fence match and off the body', () => {
        const p = parseFrontMatter('﻿---\ntitle: Hi\n---\nbody\n');
        expect(p.frontMatter).toBe('title: Hi');
        expect(p.body).toBe('body\n');
    });

    it('tolerates trailing spaces on the fences', () => {
        const p = parseFrontMatter('---  \ntitle: Hi\n--- \nbody\n');
        expect(p.frontMatter).toBe('title: Hi');
        expect(p.body).toBe('body\n');
    });

    it('carries lists and nested maps through verbatim', () => {
        const yaml = 'tags:\n  - a\n  - b\nauthor:\n  name: Wish\n  id: 7';
        const p = parseFrontMatter(`---\n${yaml}\n---\nbody\n`);
        expect(p.frontMatter).toBe(yaml);
    });

    it('handles an empty body (closing fence at EOF, no trailing newline)', () => {
        const p = parseFrontMatter('---\ntitle: Hi\n---');
        expect(p.frontMatter).toBe('title: Hi');
        expect(p.body).toBe('');
    });
});

describe('joinFrontMatter — the round-trip guarantee', () => {
    const CORPUS: Array<[string, string]> = [
        ['no front matter', '# Title\n\nSome *body*.\n'],
        ['plain block', '---\ntitle: Hi\n---\n\n# Body\n'],
        ['crlf throughout', '---\r\ntitle: Hi\r\nid: 4\r\n---\r\n\r\n# Body\r\n'],
        ['empty block', '---\n---\nbody\n'],
        ['bom', '﻿---\ntitle: Hi\n---\nbody\n'],
        ['fence trailing spaces', '---  \ntitle: Hi\n--- \nbody\n'],
        ['lists and nesting', '---\ntags:\n  - a\n  - b\nauthor:\n  name: Wish\n---\nbody\n'],
        ['comments and blank lines', '---\n# a comment\n\ntitle: Hi\n\n---\nbody\n'],
        ['no trailing newline', '---\ntitle: Hi\n---'],
        ['mid-document rule', '# Title\n\n---\n\nnot front matter\n'],
        ['empty file', ''],
        ['just a fence', '---\n'],
        ['mdc rule', '---\ndescription: Do the thing\nglobs: **/*.ts\nalwaysApply: false\n---\n\nRule body.\n'],
    ];

    it.each(CORPUS)('is byte-stable for %s when nothing changed', (_name, text) => {
        const p = parseFrontMatter(text);
        expect(joinFrontMatter(p, p.frontMatter, p.body)).toBe(text);
    });

    it('rewrites only the block when the front matter changes', () => {
        const p = parseFrontMatter('---\ntitle: Hi\n---\n\n# Body\n');
        expect(joinFrontMatter(p, 'title: Bye', p.body)).toBe('---\ntitle: Bye\n---\n\n# Body\n');
    });

    it('writes the new block with the file\'s own CRLF', () => {
        const p = parseFrontMatter('---\r\ntitle: Hi\r\n---\r\n# Body\r\n');
        expect(joinFrontMatter(p, 'title: Bye', p.body)).toBe(
            '---\r\ntitle: Bye\r\n---\r\n# Body\r\n',
        );
    });

    it('drops the block (and its trailing blank line) when the front matter goes null', () => {
        const p = parseFrontMatter('---\ntitle: Hi\n---\n\n# Body\n');
        expect(joinFrontMatter(p, null, p.body)).toBe('# Body\n');
    });

    it('drops the block from a CRLF file without leaving a blank first line', () => {
        const p = parseFrontMatter('---\r\ntitle: Hi\r\n---\r\n\r\n# Body\r\n');
        expect(joinFrontMatter(p, null, p.body)).toBe('# Body\r\n');
    });

    it('adds a block above a document that had none, separated by a blank line', () => {
        const p = parseFrontMatter('# Body\n');
        expect(joinFrontMatter(p, 'title: Hi', p.body)).toBe('---\ntitle: Hi\n---\n\n# Body\n');
    });

    it('adds a block to an empty document without a stray blank line', () => {
        const p = parseFrontMatter('');
        expect(joinFrontMatter(p, 'title: Hi', p.body)).toBe('---\ntitle: Hi\n---\n');
    });

    it('keeps the BOM when the block is rewritten', () => {
        const p = parseFrontMatter('﻿---\ntitle: Hi\n---\nbody\n');
        expect(joinFrontMatter(p, 'title: Bye', p.body)).toBe('﻿---\ntitle: Bye\n---\nbody\n');
    });

    it('takes a new body alongside an untouched block', () => {
        const p = parseFrontMatter('---\ntitle: Hi\n---\n# Body\n');
        expect(joinFrontMatter(p, p.frontMatter, '# Edited\n')).toBe(
            '---\ntitle: Hi\n---\n# Edited\n',
        );
    });

    it('re-parses what it wrote (idempotent through a second pass)', () => {
        const p = parseFrontMatter('# Body\n');
        const once = joinFrontMatter(p, 'title: Hi', p.body);
        const p2 = parseFrontMatter(once);
        expect(p2.frontMatter).toBe('title: Hi');
        expect(joinFrontMatter(p2, p2.frontMatter, p2.body)).toBe(once);
    });
});

describe('parseFrontMatterFields', () => {
    it('types the scalar shapes YAML can hold', () => {
        const { fields, structured } = parseFrontMatterFields(
            'title: Hello\ncount: 42\nratio: 1.5\nalwaysApply: false\nempty:\nnothing: null',
        );
        expect(structured).toBe(true);
        expect(fields.map((f) => [f.key, f.kind, f.value])).toEqual([
            ['title', 'string', 'Hello'],
            ['count', 'number', '42'],
            ['ratio', 'number', '1.5'],
            ['alwaysApply', 'boolean', 'false'],
            ['empty', 'null', ''],
            ['nothing', 'null', ''],
        ]);
    });

    it('unquotes quoted strings and keeps them typed as strings', () => {
        const { fields } = parseFrontMatterFields(
            'a: "true"\nb: \'42\'\nc: "with: colon"\nd: "say \\"hi\\""',
        );
        expect(fields.map((f) => [f.key, f.kind, f.value])).toEqual([
            ['a', 'string', 'true'],
            ['b', 'string', '42'],
            ['c', 'string', 'with: colon'],
            ['d', 'string', 'say "hi"'],
        ]);
    });

    it('strips a trailing comment from an unquoted scalar but not from a quoted one', () => {
        const { fields } = parseFrontMatterFields('a: yes please # note\nb: "hash # inside"');
        expect(fields[0]?.value).toBe('yes please');
        expect(fields[1]?.value).toBe('hash # inside');
    });

    it('reads a block sequence as a list', () => {
        const { fields, structured } = parseFrontMatterFields('tags:\n  - alpha\n  - "beta"');
        expect(structured).toBe(true);
        expect(fields[0]?.kind).toBe('list');
        expect(fields[0]?.items).toEqual(['alpha', 'beta']);
    });

    it('reads a zero-indent block sequence as a list too', () => {
        const { fields } = parseFrontMatterFields('tags:\n- alpha\n- beta');
        expect(fields[0]?.kind).toBe('list');
        expect(fields[0]?.items).toEqual(['alpha', 'beta']);
    });

    it('reads a flow sequence as a list', () => {
        const { fields } = parseFrontMatterFields('tags: [alpha, "beta, too"]');
        expect(fields[0]?.kind).toBe('list');
        expect(fields[0]?.items).toEqual(['alpha', 'beta, too']);
    });

    it('reads an empty flow sequence as an empty list', () => {
        const { fields } = parseFrontMatterFields('tags: []');
        expect(fields[0]?.kind).toBe('list');
        expect(fields[0]?.items).toEqual([]);
    });

    it('marks a nested map complex — the structured editor cannot represent it', () => {
        const { fields, structured } = parseFrontMatterFields(
            'title: Hi\nauthor:\n  name: Wish\n  id: 7',
        );
        expect(structured).toBe(true);
        expect(fields.map((f) => [f.key, f.kind])).toEqual([
            ['title', 'string'],
            ['author', 'complex'],
        ]);
        expect(fields[1]?.raw).toBe('author:\n  name: Wish\n  id: 7');
    });

    it('marks a block literal complex', () => {
        const { fields } = parseFrontMatterFields('note: |\n  line one\n  line two');
        expect(fields[0]?.kind).toBe('complex');
    });

    it('ignores comments and blank lines', () => {
        const { fields, structured } = parseFrontMatterFields('# lead-in\n\ntitle: Hi\n\n# tail');
        expect(structured).toBe(true);
        expect(fields.map((f) => f.key)).toEqual(['title']);
    });

    it('is UNSTRUCTURED when the block is a top-level sequence', () => {
        expect(parseFrontMatterFields('- a\n- b').structured).toBe(false);
    });

    it('is UNSTRUCTURED when the block is a bare scalar', () => {
        expect(parseFrontMatterFields('just a string').structured).toBe(false);
    });

    it('is structured (and empty) for an empty block', () => {
        expect(parseFrontMatterFields('')).toEqual({ fields: [], structured: true });
    });

    // A hand-written block can repeat a key. Each occurrence has to be read at
    // its OWN position — resolving both to the first one walks the cursor
    // backwards and never terminates.
    it('reads a repeated key once per occurrence instead of hanging', () => {
        const { fields } = parseFrontMatterFields('a: 1\nb: x\na: 2');
        expect(fields.map((f) => [f.key, f.value])).toEqual([
            ['a', '1'],
            ['b', 'x'],
            ['a', '2'],
        ]);
    });
});

describe('setFrontMatterField', () => {
    it('replaces a scalar in place, leaving every other line untouched', () => {
        expect(
            setFrontMatterField('# note\ntitle: Hi\nid: 4', 'title', {
                kind: 'string',
                value: 'Bye',
            }),
        ).toBe('# note\ntitle: Bye\nid: 4');
    });

    it('appends a key that is not there yet', () => {
        expect(setFrontMatterField('title: Hi', 'id', { kind: 'number', value: '4' })).toBe(
            'title: Hi\nid: 4',
        );
    });

    it('seeds the first key of an empty block', () => {
        expect(setFrontMatterField('', 'title', { kind: 'string', value: 'Hi' })).toBe('title: Hi');
    });

    it('writes booleans, numbers and null unquoted', () => {
        let y = '';
        y = setFrontMatterField(y, 'a', { kind: 'boolean', value: 'true' });
        y = setFrontMatterField(y, 'b', { kind: 'number', value: '-1.5' });
        y = setFrontMatterField(y, 'c', { kind: 'null', value: '' });
        expect(y).toBe('a: true\nb: -1.5\nc: null');
    });

    it('quotes a string that would otherwise read as another type', () => {
        let y = '';
        y = setFrontMatterField(y, 'a', { kind: 'string', value: 'true' });
        y = setFrontMatterField(y, 'b', { kind: 'string', value: '42' });
        y = setFrontMatterField(y, 'c', { kind: 'string', value: '' });
        y = setFrontMatterField(y, 'd', { kind: 'string', value: 'null' });
        expect(y).toBe('a: "true"\nb: "42"\nc: ""\nd: "null"');
    });

    it('quotes a string whose punctuation would break the line', () => {
        let y = '';
        y = setFrontMatterField(y, 'a', { kind: 'string', value: 'key: value' });
        y = setFrontMatterField(y, 'b', { kind: 'string', value: '**/*.ts' });
        y = setFrontMatterField(y, 'c', { kind: 'string', value: ' padded ' });
        y = setFrontMatterField(y, 'd', { kind: 'string', value: 'trailing # hash' });
        expect(y).toBe('a: "key: value"\nb: "**/*.ts"\nc: " padded "\nd: "trailing # hash"');
    });

    it('leaves an ordinary string unquoted', () => {
        expect(setFrontMatterField('', 'a', { kind: 'string', value: 'Do the thing' })).toBe(
            'a: Do the thing',
        );
    });

    it('escapes quotes and newlines inside a double-quoted string', () => {
        expect(setFrontMatterField('', 'a', { kind: 'string', value: 'say "hi"\nagain' })).toBe(
            'a: "say \\"hi\\"\\nagain"',
        );
    });

    it('escapes a trailing backslash in a quoted key so it cannot escape the closing quote', () => {
        // js/incomplete-sanitization: the key needs quoting (the colon) AND ends
        // with a backslash. Unescaped, it renders as `"a:b\"` — the trailing
        // backslash escapes the closing quote, terminates the YAML string early
        // and drops the field on the way back in. The key encoder must escape
        // backslashes just like the scalar encoder does.
        const key = 'a:b\\';
        expect(setFrontMatterField('', key, { kind: 'string', value: 'v' })).toBe('"a:b\\\\": v');
        expect(
            parseFrontMatterFields(
                setFrontMatterField('', key, { kind: 'string', value: 'v' }),
            ).fields[0],
        ).toMatchObject({ key, value: 'v' });
    });

    it('writes a list as a block sequence', () => {
        expect(
            setFrontMatterField('title: Hi', 'tags', { kind: 'list', items: ['a', 'b c'] }),
        ).toBe('title: Hi\ntags:\n  - a\n  - b c');
    });

    it('writes an empty list as a flow []', () => {
        expect(setFrontMatterField('', 'tags', { kind: 'list', items: [] })).toBe('tags: []');
    });

    it('replaces a multi-line list with a scalar, dropping every old item line', () => {
        expect(
            setFrontMatterField('tags:\n  - a\n  - b\nid: 4', 'tags', {
                kind: 'string',
                value: 'none',
            }),
        ).toBe('tags: none\nid: 4');
    });

    it('replaces a scalar with a list without disturbing the keys after it', () => {
        expect(
            setFrontMatterField('tags: none\nid: 4', 'tags', { kind: 'list', items: ['a'] }),
        ).toBe('tags:\n  - a\nid: 4');
    });

    it('round-trips through parseFrontMatterFields', () => {
        const y = setFrontMatterField('', 'globs', { kind: 'string', value: '**/*.ts' });
        expect(parseFrontMatterFields(y).fields[0]).toMatchObject({
            key: 'globs',
            kind: 'string',
            value: '**/*.ts',
        });
    });
});

describe('renameFrontMatterField', () => {
    it('renames the key and keeps the value', () => {
        expect(renameFrontMatterField('title: Hi\nid: 4', 'title', 'name')).toBe(
            'name: Hi\nid: 4',
        );
    });

    it('keeps a list attached to its renamed key', () => {
        expect(renameFrontMatterField('tags:\n  - a\n  - b', 'tags', 'labels')).toBe(
            'labels:\n  - a\n  - b',
        );
    });

    it('keeps the block valid by dropping a colliding key rather than duplicating it', () => {
        expect(renameFrontMatterField('title: Hi\nname: Old\nid: 4', 'title', 'name')).toBe(
            'name: Hi\nid: 4',
        );
    });

    it('leaves the block alone when the key is not there', () => {
        expect(renameFrontMatterField('title: Hi', 'nope', 'name')).toBe('title: Hi');
    });

    it('is a no-op when the name does not change', () => {
        expect(renameFrontMatterField('title: Hi', 'title', 'title')).toBe('title: Hi');
    });
});

describe('removeFrontMatterField', () => {
    it('drops the key line', () => {
        expect(removeFrontMatterField('title: Hi\nid: 4', 'title')).toBe('id: 4');
    });

    it('drops every line of a multi-line value', () => {
        expect(removeFrontMatterField('tags:\n  - a\n  - b\nid: 4', 'tags')).toBe('id: 4');
    });

    it('leaves an empty string when the last key goes', () => {
        expect(removeFrontMatterField('title: Hi', 'title')).toBe('');
    });

    it('leaves the block alone when the key is not there', () => {
        expect(removeFrontMatterField('title: Hi', 'nope')).toBe('title: Hi');
    });
});

describe('frontMatterPill', () => {
    it('offers to add a block when the file has none', () => {
        expect(frontMatterPill(null)).toEqual({
            present: false,
            keys: 0,
            label: 'fm +',
            title: 'This file has no front matter — add some',
        });
    });

    it('counts the keys it is standing for', () => {
        expect(frontMatterPill('title: Hi')).toMatchObject({ present: true, keys: 1, label: 'fm · 1 key' });
        expect(frontMatterPill('title: Hi\ntags:\n  - a\n  - b')).toMatchObject({
            keys: 2,
            label: 'fm · 2 keys',
        });
    });

    it('still reads as present for an empty block — the fences are in the file', () => {
        expect(frontMatterPill('')).toMatchObject({ present: true, keys: 0, label: 'fm · 0 keys' });
    });

    it('does not claim keys for a block the field list cannot represent', () => {
        expect(frontMatterPill('- a\n- b')).toMatchObject({ present: true, label: 'fm · YAML' });
    });
});

describe('normalizeFrontMatter', () => {
    it('turns a block with nothing left in it into no block at all', () => {
        expect(normalizeFrontMatter('')).toBeNull();
        expect(normalizeFrontMatter('  \n\n')).toBeNull();
    });

    it('keeps a block that still holds something — comments included', () => {
        expect(normalizeFrontMatter('title: Hi')).toBe('title: Hi');
        expect(normalizeFrontMatter('# keep me')).toBe('# keep me');
    });
});

describe('convertFmValue', () => {
    const field = (over: Partial<FmField>): FmField =>
        ({ key: 'k', kind: 'string', value: '', raw: '', ...over }) as FmField;

    it('keeps the text when a value becomes a string', () => {
        expect(convertFmValue(field({ kind: 'number', value: '42' }), 'string')).toEqual({
            kind: 'string',
            value: '42',
        });
    });

    it('seeds a list from the scalar it replaces, and empty from nothing', () => {
        expect(convertFmValue(field({ value: 'alpha' }), 'list')).toEqual({
            kind: 'list',
            items: ['alpha'],
        });
        expect(convertFmValue(field({ kind: 'null' }), 'list')).toEqual({
            kind: 'list',
            items: [],
        });
    });

    it('joins a list back into a string', () => {
        expect(
            convertFmValue(field({ kind: 'list', value: '', items: ['a', 'b'] }), 'string'),
        ).toEqual({ kind: 'string', value: 'a, b' });
    });

    it('reads truthiness off the old value when a field becomes a boolean', () => {
        expect(convertFmValue(field({ value: 'true' }), 'boolean')).toEqual({
            kind: 'boolean',
            value: 'true',
        });
        expect(convertFmValue(field({ value: 'anything else' }), 'boolean')).toEqual({
            kind: 'boolean',
            value: 'false',
        });
    });

    it('falls back to 0 when the old value is not a number', () => {
        expect(convertFmValue(field({ value: '1.5' }), 'number')).toEqual({
            kind: 'number',
            value: '1.5',
        });
        expect(convertFmValue(field({ value: 'nope' }), 'number')).toEqual({
            kind: 'number',
            value: '0',
        });
    });

    it('empties the value on the way to null', () => {
        expect(convertFmValue(field({ value: 'x' }), 'null')).toEqual({ kind: 'null', value: '' });
    });
});

describe('editing a real .mdc rule end to end', () => {
    const FILE =
        '---\ndescription: Guard the seam\nglobs: **/*.ts\nalwaysApply: false\n---\n\nAlways check the seam.\n';

    it('renames, retypes and removes without touching the body', () => {
        const p = parseFrontMatter(FILE);
        let yaml = p.frontMatter as string;
        yaml = setFrontMatterField(yaml, 'alwaysApply', { kind: 'boolean', value: 'true' });
        yaml = renameFrontMatterField(yaml, 'description', 'summary');
        yaml = removeFrontMatterField(yaml, 'globs');
        yaml = setFrontMatterField(yaml, 'tags', { kind: 'list', items: ['seam', 'ts'] });

        expect(joinFrontMatter(p, yaml, p.body)).toBe(
            '---\nsummary: Guard the seam\nalwaysApply: true\ntags:\n  - seam\n  - ts\n---\n\nAlways check the seam.\n',
        );
    });

    it('removing every key removes the block', () => {
        const p = parseFrontMatter(FILE);
        let yaml = p.frontMatter as string;
        for (const f of parseFrontMatterFields(yaml).fields) {
            yaml = removeFrontMatterField(yaml, f.key);
        }
        expect(yaml).toBe('');
        expect(joinFrontMatter(p, yaml.trim() === '' ? null : yaml, p.body)).toBe(
            'Always check the seam.\n',
        );
    });
});
