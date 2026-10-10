import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ORPHAN_REPORT_LIMIT, orphansUnder, updaterChannel } from '../src/main/upgrade.js';

/**
 * UPGRADES — §7, and two of the eight failures that ended the previous build.
 *
 * **§0.6:** an upgrade jammed on **31 orphaned `OpenConsole.exe` processes with no error
 * message at all.** The installer could not replace files that running processes held open,
 * the processes were children of a Genie that had already exited, and nothing in the product
 * knew they existed. The user saw an update that simply never finished.
 *
 * **§0.8:** the updater **could never see a release.** Every release publishes as a
 * prerelease, `allowPrerelease` defaults to false and was never set, so "Check for updates"
 * had never worked — for the entire life of the product.
 */

describe('the updater can see the channel it publishes to', () => {
    /**
     * Both halves, and that is the whole point of §7.3.
     *
     * Asserting only that `allowPrerelease` is set lets somebody later change the publish
     * channel to `release` and leave a flag that now does nothing — true, inert, and
     * reassuring. Asserting only the publish config lets somebody drop the flag. The pair is
     * what keeps either from going stale, because this test fails if they stop agreeing.
     */
    it('publishes as a PRERELEASE', () => {
        const yaml = readFileSync('electron-builder.yml', 'utf8');
        expect(yaml).toMatch(/releaseType:\s*prerelease/);
    });

    it('and allows prereleases in the updater', () => {
        expect(updaterChannel.allowPrerelease).toBe(true);
    });

    it('states the link between them where somebody changing one will read it', () => {
        // A comment is not a test, but an undocumented pair is a pair somebody breaks without
        // knowing there was a pair. The assertion is that the warning exists in the file a
        // person edits.
        const yaml = readFileSync('electron-builder.yml', 'utf8');
        expect(yaml).toContain('allowPrerelease');
    });
});

describe('orphans under the install directory', () => {
    const INSTALL = '/opt/programs/Genie';

    const proc = (pid: number, exe: string) => ({ pid, executable: exe });

    it('finds every process running from the install directory, not just one with a pidfile', () => {
        /**
         * *"Not just the one with a pidfile."* The 31 orphans had no pidfile — they were
         * console hosts spawned by a pty host that had itself exited. Anything that knows only
         * about processes it recorded cannot find them.
         */
        const found = orphansUnder(
            [
                proc(1, '/opt/programs/Genie/Genie.exe'),
                proc(2, '/opt/programs/Genie/resources/OpenConsole.exe'),
                proc(3, '/usr/bin/node'),
                proc(4, '/opt/programs/Genie2/Genie.exe'),
            ],
            INSTALL,
            999,
        );

        expect(found.map((p) => p.pid)).toEqual([1, 2]);
    });

    it('does NOT mistake a sibling install for this one', () => {
        // `/opt/programs/Genie2` is a different installation. Killing its processes during our
        // upgrade would reach into an application we do not own.
        const found = orphansUnder([proc(4, '/opt/programs/Genie2/Genie.exe')], INSTALL, 999);
        expect(found).toEqual([]);
    });

    it('never includes OUR OWN process', () => {
        // Genie's own executable is under the install directory. A teardown that killed the
        // process running it would stop the upgrade it was performing.
        const found = orphansUnder([proc(42, '/opt/programs/Genie/Genie.exe')], INSTALL, 42);
        expect(found).toEqual([]);

        // POSITIVE CONTROL: the same process under a different pid IS found, so the exclusion
        // is about identity rather than about the path.
        expect(orphansUnder([proc(42, '/opt/programs/Genie/Genie.exe')], INSTALL, 7)).toHaveLength(1);
    });

    it('reports an empty list as empty rather than as nothing to say', () => {
        // The difference matters to the caller: "we looked and found none" is a report, and
        // §7.2 requires the teardown to REPORT what it killed — including when that is nothing.
        expect(orphansUnder([proc(3, '/usr/bin/node')], INSTALL, 999)).toEqual([]);
    });

    it('matches case-insensitively on Windows paths', () => {
        // `C:\\Program Files\\Genie` and `c:/program files/genie` are one directory, and an
        // orphan found under one spelling and missed under the other is 31 orphans again.
        const found = orphansUnder(
            [proc(1, 'C:\\Program Files\\Genie\\resources\\OpenConsole.exe')],
            'c:/program files/genie',
            999,
            true,
        );
        expect(found).toHaveLength(1);
    });

    it('caps what it REPORTS without capping what it finds', () => {
        /**
         * Thirty-one orphans is a readable number; three thousand is not. But the cap is on the
         * message, never on the list — a teardown that killed only the first ten would leave
         * the rest holding files open and the upgrade would jam exactly as before.
         */
        const many = Array.from({ length: 100 }, (_, i) => proc(i + 1, `${INSTALL}/helper-${i}.exe`));
        const found = orphansUnder(many, INSTALL, 999);

        expect(found).toHaveLength(100);
        expect(ORPHAN_REPORT_LIMIT).toBeLessThan(100);
    });
});
