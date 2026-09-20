import { describe, expect, it } from 'vitest';
import { codeOnly, codeOnlyHtml } from '../code-only';

/**
 * The stripper every source-reading guard depends on (genie#404).
 *
 * These assertions distinguish the two implementations. A span-based stripper
 * passes the first two and FAILS the third — and the third is the one that
 * decides whether a guard can be silently blinded.
 */
describe('codeOnly', () => {
    it('removes whole-line comments', () => {
        expect(codeOnly('// gone\nconst a = 1;').trim()).toBe('const a = 1;');
    });

    it('removes a trailing comment without eating the code on that line', () => {
        expect(codeOnly('const a = 1; // why').trim()).toBe('const a = 1;');
    });

    it('a /* INSIDE A STRING does not open a comment span', () => {
        // THE bug. A span stripper deletes from the literal to the next real
        // star-slash — every line between vanishes from the scan and the guard
        // reports the file clean. `forbidden` sits between the two and must
        // survive.
        // The literal must be UNTERMINATED on its own line. An earlier draft
        // used `'/**/*.ts'`, which closes its own span immediately — the OLD
        // stripper passed that, so the test proved nothing about the defect it
        // names. Verified against the old implementation, this fixture
        // truncates the whole output to `const hint = 'see `, taking both
        // later lines with it.
        const src = [
            "const hint = 'see /* here';",
            'const forbidden = 1;',
            'const done = 2; /* real */',
        ].join('\n');
        const out = codeOnly(src);
        expect(out).toContain('forbidden');
        expect(out).toContain('done');
    });

    it('is CRLF-safe', () => {
        // A guard anchored on a bare \n is inert on a CRLF checkout and passes
        // silently (genie#517).
        expect(codeOnly('// gone\r\nconst a = 1;').trim()).toBe('const a = 1;');
    });

    it('codeOnlyHtml also drops HTML comments', () => {
        expect(codeOnlyHtml('<!-- gone -->\n<div>keep</div>')).toContain('keep');
        expect(codeOnlyHtml('<!-- window.genie -->\n<div>keep</div>')).not.toContain('window.genie');
    });
});
