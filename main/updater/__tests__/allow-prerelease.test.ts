import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * EVERY GENIE RELEASE IS A PRERELEASE, SO THE UPDATER HAS TO ALLOW THEM.
 *
 * `finalize-release` publishes with `--prerelease=true`, and electron-updater's
 * `allowPrerelease` defaults to FALSE — so "Check for updates" skipped every release Genie
 * has ever cut. The owner installed beta.2 and beta.3 from a link and asked both times why
 * the app offered nothing.
 *
 * SOURCE-LEVEL, like `agent-verbs-wiring.test.ts` next door: `auto-updater.ts` reaches for
 * Electron's `autoUpdater` singleton at import, so there is no cheap behavioural harness —
 * and the failure mode is a missing assignment, which only a call-site check can see.
 *
 * Note which thing is NOT asserted: `releaseType` in `electron-builder.yml`. It was the
 * obvious suspect and it is a red herring — measured in
 * `electron-updater/out/providers/GitHubProvider.js`, the string does not appear there at
 * all, so it is a publish option with no effect on the runtime check. Pinning it would
 * record a false cause.
 */
const read = (rel: string): string => fs.readFileSync(path.join(__dirname, '..', '..', '..', rel), 'utf8');

describe('the updater can see a prerelease', () => {
    it('sets allowPrerelease where it sets the other autoUpdater flags', () => {
        const src = read('main/updater/auto-updater.ts');

        // The assignment, tolerant of whitespace but not of its absence.
        expect(src).toMatch(/autoUpdater\.allowPrerelease\s*=\s*true/);
    });

    it('POSITIVE CONTROL: the flags it sits beside are still there', () => {
        // Without this, the assertion above would pass against a file that had been gutted
        // or moved, and "the line is present" would be measuring nothing in particular.
        const src = read('main/updater/auto-updater.ts');

        expect(src).toMatch(/autoUpdater\.autoDownload\s*=\s*false/);
        expect(src).toMatch(/autoUpdater\.autoInstallOnAppQuit\s*=\s*false/);
    });

    it('never turns it off again somewhere else', () => {
        // A second assignment later in the file would win and be invisible here otherwise.
        // COUNT, not a boolean: exactly one assignment, and it is the true one.
        const src = read('main/updater/auto-updater.ts');
        const assignments = src.match(/autoUpdater\.allowPrerelease\s*=\s*\w+/g) ?? [];

        expect(assignments).toHaveLength(1);
        expect(assignments[0]).toMatch(/=\s*true$/);
    });

    it('releases really are published as prereleases — the reason this is needed', () => {
        // If this ever stops being true, the flag above becomes unnecessary rather than
        // load-bearing, and whoever reads it deserves to find that out here.
        expect(read('.github/workflows/release.yml')).toMatch(/--prerelease=true/);
    });
});
