import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The Knowledge Graph is a standalone window that already receives Genie's
 * active light/dark class. Its controls nevertheless carried a second, inline
 * dark-only palette: white ink, white-alpha borders/backgrounds, and an
 * unconditional `prose-invert`. In light mode that made real labels look like
 * empty lavender boxes.
 *
 * Keep this page on the shared `--bg-*` / `--fg-*` / `--border-*` and semantic
 * colour tokens. A fixed colour here cannot react when the root theme changes.
 */

const page = readFileSync(join(__dirname, '..', '..', 'pages', 'knowledge.tsx'), 'utf8');
const source = page.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, ' '))
    .replace(/^[ \t]*\/\/.*$/gm, '');
const lineOf = (index: number) => source.slice(0, index).split('\n').length;

describe('Knowledge Graph theme colours', () => {
    it('uses theme tokens instead of a private dark-only palette', () => {
        // Positive controls: this is the intended page and the scan reaches the
        // exact surfaces from the report. A missing/empty file cannot pass.
        expect(page).toContain('function GraphView');
        expect(page).toContain('const searchInputStyle');
        expect(page).toContain('const linkChipStyle');
        expect(page).toContain('const primaryBtnStyle');

        const fixedColours = [...source.matchAll(/#[0-9a-f]{3,8}\b|rgba?\(/gi)].map(
            (match) => `renderer/pages/knowledge.tsx:${lineOf(match.index!)} ${match[0]}`,
        );
        expect(fixedColours).toEqual([]);
        expect(source).not.toMatch(/\btext-zinc-\d+\b/);
    });

    it('inverts rendered markdown only in dark mode', () => {
        expect(source).toContain('className="prose max-w-3xl dark:prose-invert"');
        expect(source).not.toContain('className="prose prose-invert');
    });
});
