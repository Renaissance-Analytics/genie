import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * THE TOOLCHAIN ROW'S "INSTALLED" MOMENT (Tynn #968; rows 1125-195556-df6ca9 and 1125-201049-4c96a1). An install is done
 * when pacman has the package AND the card shows a version. A card with no version reads "not here", and a language card
 * (PHP's) has no data-tone, so "a version" has to be a version: with any text counting, php's check judged the card while
 * pacman was still installing, before Genie's rescan, and read "card not here".
 */
const row = readFileSync(join(__dirname, '..', 'scripts', 'toolchain-real-cdp.mjs'), 'utf8');

describe('the row waits for the version the card shows', () => {
    it('an install is done only when the card shows a VERSION, never its "not here"', () => {
        expect(row).toMatch(/const shows = \(c\) => Boolean\(c\?\.version && \/\\d\/\.test\(c\.version\)\);/);
        expect(row).toMatch(/press\(tool, '\^Install\$'\), async \(\) => \{ if \(!pkgVersion\(pkg\)\) return null; const c = await card\(tool\); return c && c\.tone !== 'not-installed' && shows\(c\) \? c : null; \}/);
    });
});
