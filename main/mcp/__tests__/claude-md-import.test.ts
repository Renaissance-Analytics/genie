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
