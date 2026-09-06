import { describe, expect, it } from 'vitest';
import { extractFileRefs } from '../ask-file-refs';

/**
 * Finding the files a ForceTheQuestion question is ABOUT (Tynn story #272).
 *
 * A question that says "does §3 of `.ai/plans/impactium-actioncatalog-spec.md`
 * still hold?" hands the reader a path and nothing else: to answer it they have
 * to leave the modal, find the file, and come back to a question they have by
 * then half-forgotten. The modal opens the file beside the question instead —
 * but only once it can tell which words in the markdown ARE files.
 *
 * The hard half is what NOT to match. A question is prose written by an agent,
 * full of version strings, sentences and URLs, and every false positive is a
 * chip offering to open a file that does not exist.
 */

describe('extractFileRefs', () => {
    it('finds a path in an inline code span', () => {
        expect(extractFileRefs('Does `.ai/plans/spec.md` still hold?')).toEqual([
            { path: '.ai/plans/spec.md', name: 'spec.md' },
        ]);
    });

    it('carries the section the question pointed at', () => {
        expect(extractFileRefs('Check `.ai/plans/spec.md §3` before answering.')).toEqual([
            { path: '.ai/plans/spec.md', name: 'spec.md', section: '§3' },
        ]);
    });

    it('reads a section written outside the code span', () => {
        expect(extractFileRefs('Check `.ai/plans/spec.md` §3 before answering.')).toEqual([
            { path: '.ai/plans/spec.md', name: 'spec.md', section: '§3' },
        ]);
    });

    it('carries a line number and strips it from the path', () => {
        expect(extractFileRefs('See `main/ask/force-question.ts:695`.')).toEqual([
            { path: 'main/ask/force-question.ts', name: 'force-question.ts', line: 695 },
        ]);
    });

    it('reads a path out of prose, not just code spans', () => {
        expect(extractFileRefs('I changed renderer/pages/ask.tsx to fix it.')).toEqual([
            { path: 'renderer/pages/ask.tsx', name: 'ask.tsx' },
        ]);
    });

    it('takes the target of a markdown link', () => {
        expect(extractFileRefs('See [the spec](docs/plan.md) for why.')).toEqual([
            { path: 'docs/plan.md', name: 'plan.md' },
        ]);
    });

    it('reads a Windows path', () => {
        expect(extractFileRefs('Open `C:\\Projects\\genie\\main\\db.ts`.')).toEqual([
            { path: 'C:\\Projects\\genie\\main\\db.ts', name: 'db.ts' },
        ]);
    });

    it('keeps every distinct file, in the order the question names them', () => {
        const refs = extractFileRefs('Compare `a/one.ts` with `b/two.ts` and `a/one.ts` again.');
        expect(refs.map((r) => r.path)).toEqual(['a/one.ts', 'b/two.ts']);
    });

    it('is not fooled by a URL', () => {
        expect(extractFileRefs('See https://example.com/plans/spec.md for the plan.')).toEqual([]);
    });

    it('is not fooled by a version string', () => {
        expect(extractFileRefs('Shipped in `v0.7.0-beta.303`, not before.')).toEqual([]);
    });

    it('is not fooled by an ordinary sentence', () => {
        expect(
            extractFileRefs('The agent finished. It found nothing, e.g. no regression.'),
        ).toEqual([]);
    });

    it('leaves a trailing full stop out of the path', () => {
        expect(extractFileRefs('It lives in main/ask/inbox.ts.')).toEqual([
            { path: 'main/ask/inbox.ts', name: 'inbox.ts' },
        ]);
    });

    it('takes a bare filename only when the question set it in code', () => {
        expect(extractFileRefs('Edit `package.json` to bump it.')).toEqual([
            { path: 'package.json', name: 'package.json' },
        ]);
        expect(extractFileRefs('Edit package.json to bump it.')).toEqual([]);
    });

    it('caps the chips so a question listing a whole tree stays readable', () => {
        const many = Array.from({ length: 20 }, (_, i) => `\`src/f${i}.ts\``).join(' ');
        expect(extractFileRefs(many)).toHaveLength(8);
    });

    it('finds nothing in an empty question', () => {
        expect(extractFileRefs('')).toEqual([]);
    });
});
