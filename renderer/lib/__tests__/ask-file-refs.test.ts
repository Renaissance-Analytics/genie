import { describe, expect, it } from 'vitest';
import { extractFileRefs, splitByExistence, type AskFileRef } from '../ask-file-refs';

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

    it('never takes a bare filename — in code or not, it names no location', () => {
        // genie#475. A bare name says WHICH file, never WHERE, and the modal has
        // exactly one place to look: the workspace root. In an `.agi` envelope
        // with eleven repos under `repos/`, every one of which has a
        // package.json, that root is almost never the one meant.
        expect(extractFileRefs('Edit `package.json` to bump it.')).toEqual([]);
        expect(extractFileRefs('Edit package.json to bump it.')).toEqual([]);
    });

    it('positive control: the same filename UNDER A PATH is still a chip', () => {
        // The rule is about the separator, not about the word. Without this the
        // test above would pass equally against a build that had stopped
        // producing chips at all.
        expect(extractFileRefs('Edit `repos/genie-tui/package.json` to bump it.')).toEqual([
            { path: 'repos/genie-tui/package.json', name: 'package.json' },
        ]);
    });

    it('does not chip filenames a question merely TALKS ABOUT (genie#475)', () => {
        // The question the owner hit: it described shims npm had written into a
        // throwaway temp prefix, naming them in prose. All three became chips,
        // and `genie.cmd` opened as `C:\_Projects\tynn.ai\genie.cmd` — ENOENT.
        const md =
            'npm put `genie.cmd`, `genie.ps1` and a `package.json` in the temp prefix. Proceed?';
        expect(extractFileRefs(md)).toEqual([]);
    });

    it('does not silently resolve a bare name to the envelope root (genie#475)', () => {
        // The worse half, because it does not announce itself. `package.json`
        // resolves to the ENVELOPE manifest, which exists — so the chip opens,
        // renders, and looks right while showing a file the question never meant.
        // An ENOENT is at least visible; this is not.
        expect(extractFileRefs('Does `package.json` still pin beta.303?')).toEqual([]);
    });

    it('caps the chips so a question listing a whole tree stays readable', () => {
        const many = Array.from({ length: 20 }, (_, i) => `\`src/f${i}.ts\``).join(' ');
        expect(extractFileRefs(many)).toHaveLength(8);
    });

    it('finds nothing in an empty question', () => {
        expect(extractFileRefs('')).toEqual([]);
    });
});

/**
 * genie#477 — a chip must point at a file that is actually there.
 *
 * Requiring a separator stopped a bare filename resolving to whatever happened
 * to sit at the workspace root. It does not stop a separated path from simply
 * being wrong: `repos/genie/main/dose.ts` names a location, so it chips, and
 * then fails on click with a raw ENOENT. The module's own standard says a chip
 * offering to open a file that isn't there is worse than no chip at all.
 */
describe('splitByExistence', () => {
    const ref = (path: string): AskFileRef => ({ path, name: path.split('/').pop()! });

    it('chips only the paths that resolve, and reports the ones that do not', () => {
        const refs = [ref('repos/genie/main/db.ts'), ref('repos/genie/main/dose.ts')];
        const split = splitByExistence(refs, new Set(['repos/genie/main/db.ts']));
        expect(split.present.map((r) => r.path)).toEqual(['repos/genie/main/db.ts']);
        expect(split.missing.map((r) => r.path)).toEqual(['repos/genie/main/dose.ts']);
    });

    it('a question naming only missing files produces no chips at all', () => {
        const split = splitByExistence([ref('repos/genie/main/dose.ts')], new Set());
        expect(split.present).toEqual([]);
        // Not a dead button — but not silence either. A chip that vanished and a
        // chip that never existed look identical to the reader, and a question
        // pointing at a file that is not there is usually the more useful signal.
        expect(split.missing.map((r) => r.name)).toEqual(['dose.ts']);
    });

    it('fails OPEN when existence could not be established', () => {
        // The probe is IPC and can fail. Showing a chip that might not open is
        // the behaviour that shipped for months; hiding every chip because a
        // round trip failed would lose a working feature outright.
        const refs = [ref('a/one.ts'), ref('b/two.ts')];
        const split = splitByExistence(refs, null);
        expect(split.present).toEqual(refs);
        expect(split.missing).toEqual([]);
    });

    it('keeps the order the question named them in', () => {
        const refs = [ref('a/one.ts'), ref('b/two.ts'), ref('c/three.ts')];
        const split = splitByExistence(refs, new Set(['c/three.ts', 'a/one.ts']));
        expect(split.present.map((r) => r.path)).toEqual(['a/one.ts', 'c/three.ts']);
    });

    it('carries the section and line through onto the chip', () => {
        const refs: AskFileRef[] = [
            { path: 'a/one.ts', name: 'one.ts', line: 42, section: '§3' },
        ];
        const split = splitByExistence(refs, new Set(['a/one.ts']));
        expect(split.present[0]).toEqual(refs[0]);
    });

    it('handles a question that named no files', () => {
        expect(splitByExistence([], new Set())).toEqual({ present: [], missing: [] });
    });
});
