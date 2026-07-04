import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
    extractTitle,
    isSafeSlug,
    listDocs,
    readDoc,
    resolveDocsDir,
} from '../docs';
import { cleanupTmpRoot, makeTmpDir } from '../../../test/helpers';

afterAll(() => cleanupTmpRoot());

/**
 * Build a throwaway docs dir with a handful of pages (some valid, some that
 * should be ignored) so list/read behaviour is exercised against real files.
 */
let docsDir: string;
beforeAll(() => {
    docsDir = makeTmpDir('docs');
    fs.writeFileSync(
        path.join(docsDir, '01-getting-started.md'),
        '# Getting Started\n\nFirst page body.\n',
    );
    fs.writeFileSync(
        path.join(docsDir, '00-overview.md'),
        '\n\n#   Welcome to Genie   \n\nIntro.\n',
    );
    fs.writeFileSync(
        path.join(docsDir, '10-sign-in.md'),
        'No heading here, just prose.\n',
    );
    // Non-numeric dev docs + non-markdown: must be excluded from the list.
    fs.writeFileSync(path.join(docsDir, 'agi-format.md'), '# Dev Doc\n');
    fs.writeFileSync(path.join(docsDir, 'notes.txt'), 'not markdown\n');
});

describe('isSafeSlug', () => {
    it('accepts NN-name slugs', () => {
        expect(isSafeSlug('00-overview')).toBe(true);
        expect(isSafeSlug('10-sign-in-and-integrations')).toBe(true);
    });

    it('rejects traversal, separators, and wrong shapes', () => {
        expect(isSafeSlug('../secret')).toBe(false);
        expect(isSafeSlug('..')).toBe(false);
        expect(isSafeSlug('00-overview/../etc')).toBe(false);
        expect(isSafeSlug('00-overview.md')).toBe(false); // extension not allowed
        expect(isSafeSlug('overview')).toBe(false); // no numeric prefix
        expect(isSafeSlug('00_overview')).toBe(false); // wrong separator
        expect(isSafeSlug('00-Overview')).toBe(false); // uppercase
        expect(isSafeSlug('')).toBe(false);
        expect(isSafeSlug(null)).toBe(false);
        expect(isSafeSlug(42 as unknown)).toBe(false);
    });
});

describe('extractTitle', () => {
    it('uses the first H1, trimmed of leading/trailing whitespace and #s', () => {
        expect(extractTitle('# Hello World\n\nbody', '00-x')).toBe('Hello World');
        expect(extractTitle('\n\n#   Spaced Title   \n', '00-x')).toBe(
            'Spaced Title',
        );
    });

    it('falls back to a title-cased slug body when there is no H1', () => {
        expect(extractTitle('just prose, no heading', '10-sign-in')).toBe(
            'Sign In',
        );
        expect(extractTitle('* a list, not a title', '03-views-and-layouts')).toBe(
            'Views And Layouts',
        );
    });
});

describe('listDocs', () => {
    it('returns numeric-prefixed md files in filename order with titles', () => {
        const list = listDocs(docsDir);
        expect(list.map((d) => d.slug)).toEqual([
            '00-overview',
            '01-getting-started',
            '10-sign-in',
        ]);
        expect(list[0].title).toBe('Welcome to Genie');
        expect(list[1].title).toBe('Getting Started');
        // No H1 → title derived from slug.
        expect(list[2].title).toBe('Sign In');
    });

    it('excludes non-numeric dev docs and non-markdown files', () => {
        const slugs = listDocs(docsDir).map((d) => d.slug);
        expect(slugs).not.toContain('agi-format');
        expect(slugs).not.toContain('notes');
    });

    it('returns [] for a missing directory', () => {
        expect(listDocs(path.join(docsDir, 'does-not-exist'))).toEqual([]);
    });
});

describe('readDoc', () => {
    it('reads the markdown for a valid slug', () => {
        const md = readDoc(docsDir, '01-getting-started');
        expect(md).toContain('# Getting Started');
    });

    it('returns null for a missing slug', () => {
        expect(readDoc(docsDir, '99-nope')).toBeNull();
    });

    it('rejects path traversal and unsafe slugs with null', () => {
        expect(readDoc(docsDir, '../../etc/passwd')).toBeNull();
        expect(readDoc(docsDir, '..')).toBeNull();
        expect(readDoc(docsDir, '00-overview.md')).toBeNull();
        expect(readDoc(docsDir, '00-overview/../../secret')).toBeNull();
        expect(readDoc(docsDir, null)).toBeNull();
    });

    it('does not read a real file outside the docs dir even by name', () => {
        // Seed a sibling file next to docsDir; a guarded read must not reach it.
        const parent = path.dirname(docsDir);
        const secret = path.join(parent, 'secret.md');
        fs.writeFileSync(secret, '# secret\n');
        // A crafted slug can't represent this path (no separators allowed), and
        // even a same-name slug only resolves inside docsDir.
        expect(readDoc(docsDir, 'secret')).toBeNull();
    });
});

describe('resolveDocsDir', () => {
    it('prefers an existing candidate', () => {
        // cwd candidate: <cwd>/docs. Point cwd at a dir that HAS a docs child.
        const root = makeTmpDir('proj');
        const inner = path.join(root, 'docs');
        fs.mkdirSync(inner);
        const resolved = resolveDocsDir('/nope/app', root);
        expect(resolved).toBe(inner);
    });

    it('falls back to the first candidate when none exist', () => {
        const resolved = resolveDocsDir('/no/app', '/no/cwd');
        expect(resolved).toBe(path.join('/no/cwd', 'docs'));
    });
});

describe('docs/README.md index discipline', () => {
    // The REAL repo docs — not a fixture. This is the guard that keeps the
    // index current: adding an `NN-name.md` page (in-app viewer) or any other
    // `*.md` doc without linking it from docs/README.md fails the build, so
    // the index can never silently drift behind the docs again.
    const repoDocs = path.resolve(__dirname, '..', '..', '..', 'docs');
    const readme = fs.readFileSync(path.join(repoDocs, 'README.md'), 'utf8');

    it('links every user-guide page (NN-name.md)', () => {
        const pages = fs
            .readdirSync(repoDocs)
            .filter((n) => /^\d{2,}-[a-z0-9-]+\.md$/.test(n));
        expect(pages.length).toBeGreaterThan(0);
        const missing = pages.filter((n) => !readme.includes(`(${n})`));
        expect(missing, `docs/README.md is missing links to: ${missing.join(', ')}`).toEqual([]);
    });

    it('links every developer/reference doc too', () => {
        const devDocs = fs
            .readdirSync(repoDocs)
            .filter(
                (n) =>
                    n.endsWith('.md') &&
                    n !== 'README.md' &&
                    !/^\d/.test(n),
            );
        const missing = devDocs.filter((n) => !readme.includes(`(${n})`));
        expect(missing, `docs/README.md is missing links to: ${missing.join(', ')}`).toEqual([]);
    });

    it('never links a page that no longer exists', () => {
        const linked = [...readme.matchAll(/\]\(([a-z0-9-]+\.md)\)/gi)].map((m) => m[1]);
        const gone = linked.filter((n) => !fs.existsSync(path.join(repoDocs, n)));
        expect(gone, `docs/README.md links to missing files: ${gone.join(', ')}`).toEqual([]);
    });
});
