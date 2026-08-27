import { describe, expect, it } from 'vitest';
import { claudeMdPointer, CLAUDE_MD_IMPORT } from '../agent-config';

/**
 * `CLAUDE.md` becomes a POINTER at `AGENTS.md`, not a second copy of it.
 *
 * What it replaces: Genie maintained two real files with identical bodies,
 * because Windows has no working symlinks. The comment that justified it also
 * recorded what it costs —
 *
 *   "It already had: this envelope's CLAUDE.md went stale enough to lose the
 *    entire Hosting Manager section."
 *
 * Two files holding the same words is a drift generator. A symlink genuinely is
 * unavailable on Windows, but it was never the only alternative: Claude Code
 * reads `CLAUDE.md` and never `AGENTS.md`, and its memory docs specify the
 * `@AGENTS.md` import for exactly this case — explicitly recommending it OVER a
 * symlink on Windows, where creating one needs Administrator or Developer Mode.
 *
 * So AGENTS.md becomes the one pristine file Genie manages, and CLAUDE.md
 * shrinks to an import plus whatever is genuinely Claude-specific.
 */
describe('claudeMdPointer', () => {
    it('imports AGENTS.md as the FIRST thing, so the framing loads first', () => {
        const out = claudeMdPointer('');

        expect(out.trimStart().startsWith(CLAUDE_MD_IMPORT)).toBe(true);
    });

    it('is short — it holds no copy of the protocol', () => {
        // The entire point. A pointer that grew a body would be the old design
        // with an extra step.
        const out = claudeMdPointer('');

        expect(out.split('\n').filter((l) => l.trim()).length).toBeLessThan(12);
        expect(out).not.toContain('GENIE PROTOCOL');
    });

    it('KEEPS a human’s Claude-specific content below the import', () => {
        // The file is Genie's to point, not to own outright: anything a human put
        // there that is genuinely Claude-specific has to survive being managed.
        const existing = `@AGENTS.md\n\n## Claude Code\n\nUse plan mode under src/billing/.\n`;

        expect(claudeMdPointer(existing)).toContain('Use plan mode under src/billing/.');
    });

    it('replaces a FULL COPY of the protocol with the import', () => {
        // The migration case, and the reason this is worth doing: an existing
        // CLAUDE.md is a stale duplicate of AGENTS.md, and leaving it is leaving
        // the drift.
        const stale = [
            '# My Project',
            '',
            '<!-- BEGIN GENIE MCP (auto-managed by Genie) -->',
            '## GENIE PROTOCOL',
            'a stale copy of everything',
            '<!-- END GENIE MCP (auto-managed by Genie) -->',
            '',
        ].join('\n');

        const out = claudeMdPointer(stale);

        expect(out).toContain(CLAUDE_MD_IMPORT);
        expect(out).not.toContain('a stale copy of everything');
        expect(out).not.toContain('GENIE PROTOCOL');
        // …and the human's own heading is not collateral damage.
        expect(out).toContain('# My Project');
    });

    it('is idempotent — managing an already-managed file changes nothing', () => {
        const once = claudeMdPointer('# P\n');

        expect(claudeMdPointer(once)).toBe(once);
    });

    it('does not import twice when the import is already there', () => {
        const out = claudeMdPointer(`${CLAUDE_MD_IMPORT}\n\n## Claude Code\n\nnotes\n`);

        expect(out.split(CLAUDE_MD_IMPORT).length - 1).toBe(1);
    });
});

/**
 * THE MIRROR CASE — the one the first cut got wrong, shipped in beta.271.
 *
 * `claudeMdPointer` strips the managed protocol block and KEEPS the rest, on the
 * reasoning that the rest is a human's Claude-specific content. That is right for
 * a CLAUDE.md someone wrote. It is wrong for the file Genie itself had been
 * maintaining — because the previous design kept the two files BYTE-IDENTICAL, so
 * "the rest" is a copy of AGENTS.md's own body.
 *
 * Measured on this envelope after the upgrade: CLAUDE.md became `@AGENTS.md`
 * followed by 168 lines that were 98.8% identical to AGENTS.md's body. Claude
 * Code then loads that content TWICE, and the file still carried the old claim
 * that the two are byte-identical mirrors — which the import had just made false.
 *
 * So the pointer needs to know what AGENTS.md says. Content that is already there
 * is DROPPED; content that is genuinely only in CLAUDE.md is kept, because a
 * human's Claude-specific note must still survive being managed.
 */
describe('claudeMdPointer against a mirrored CLAUDE.md', () => {
    const AGENTS = '# Project\n\nSome shared guidance.\n\nMore shared guidance.\n';

    it('drops a body that merely repeats AGENTS.md', () => {
        const mirrored = `# Project\n\nSome shared guidance.\n\nMore shared guidance.\n`;

        const out = claudeMdPointer(mirrored, AGENTS);

        expect(out).toContain(CLAUDE_MD_IMPORT);
        expect(out).not.toContain('Some shared guidance.');
        expect(out).not.toContain('More shared guidance.');
    });

    it('KEEPS a line that exists only in CLAUDE.md', () => {
        // Positive control, and the promise that makes this safe: managing the
        // file must not eat a human's Claude-specific note.
        const mixed = `# Project\n\nSome shared guidance.\n\nUse plan mode under src/billing/.\n`;

        const out = claudeMdPointer(mixed, AGENTS);

        expect(out).toContain('Use plan mode under src/billing/.');
        expect(out).not.toContain('Some shared guidance.');
    });

    it('still keeps everything when AGENTS.md is unknown', () => {
        // No AGENTS.md to compare against ⇒ nothing is provably duplicated, so
        // dropping would be guessing with a human's file.
        const out = claudeMdPointer('# Project\n\nMy own notes.\n');

        expect(out).toContain('My own notes.');
    });

    it('does not leave an empty shell behind when everything was duplicated', () => {
        const out = claudeMdPointer(AGENTS, AGENTS);

        // Falls back to the same scaffold an empty file gets, rather than a lone
        // import with a ragged blank tail.
        expect(out).toContain('## Claude Code');
    });
});
