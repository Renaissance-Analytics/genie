import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Nothing imports a DEPRECATED Fancy export.
 *
 * `Action` and `ActionProps` are aliases of `Button`/`ButtonProps`, and the package says
 * so in its own types: *"remains as an alias for backward compatibility and will be
 * removed in a future major version."* Twenty-nine files were still importing the old
 * name, so the next Fancy major would have broken all of them at once — and the house rule
 * is to keep the kit current, which is only possible if the codebase is not holding a
 * removed symbol.
 *
 * A guard rather than a one-off sweep, because a rename that is not enforced comes back:
 * the deprecated name still works today, so nothing but this will fail when somebody
 * reaches for it.
 *
 * CRLF-normalised before matching, per genie#517.
 */

const ROOT = path.resolve(__dirname, '..', '..', '..');

function walk(dir: string, out: string[] = []): string[] {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name === '.next') continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full, out);
        else if (/\.tsx?$/.test(entry.name)) out.push(full);
    }
    return out;
}

const files = walk(path.join(ROOT, 'renderer'));

/** The import line, per file, when it imports from the kit at all. */
function fancyImport(file: string): string | null {
    const src = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
    const m = /import \{([^}]*)\} from '@particle-academy\/react-fancy';/.exec(src);
    return m ? m[1]! : null;
}

describe('deprecated Fancy exports', () => {
    it('finds the renderer tree, so this guard cannot pass vacuously', () => {
        // Positive control. A broken walk would make every assertion below trivially true.
        expect(files.length).toBeGreaterThan(50);
        expect(files.filter((f) => fancyImport(f) !== null).length).toBeGreaterThan(20);
    });

    it('nothing imports Action or ActionProps', () => {
        const offenders = files
            .filter((f) => {
                const names = fancyImport(f);
                return names !== null && /\b(Action|ActionProps)\b/.test(names);
            })
            .map((f) => path.relative(ROOT, f));
        expect(offenders).toEqual([]);
    });

    it('the replacement IS imported where buttons are used', () => {
        // The other half: a sweep that deleted the import without adding Button would also
        // produce an empty offender list, and would fail to compile — but this says it
        // outright rather than relying on tsc to notice.
        const withButtons = files.filter((f) => {
            const src = fs.readFileSync(f, 'utf8');
            return /<Button[\s>/]/.test(src);
        });
        expect(withButtons.length).toBeGreaterThan(10);
        for (const f of withButtons) {
            const names = fancyImport(f);
            // A file may define its own Button wrapper; what matters is that any file using
            // the kit's buttons imports the kit's current name.
            if (names !== null) expect(names).toMatch(/\bButton\b/);
        }
    });
});
