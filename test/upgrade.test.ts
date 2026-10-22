import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ORPHAN_REPORT_LIMIT, orphansUnder, updaterConfigFor } from '../src/main/upgrade.js';

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
     * Both halves, and that is the whole point of §7.3 — per channel now (the owner, 2026-10-12:
     * "stable and dev update channels").
     *
     * Asserting only that `allowPrerelease` is set lets somebody later change the publish
     * default to `release` and leave a flag that now does nothing — true, inert, and
     * reassuring. Asserting only the publish config lets somebody drop the flag. The pair is
     * what keeps either from going stale, because this test fails if they stop agreeing. The
     * stable half (a plain tag → a full release) is held in test/update-channels.test.ts.
     */
    it('publishes as a DRAFT — public only when the owner publishes it; the prerelease flag is the workflow\'s (test/release-draft.test.ts)', () => {
        const yaml = readFileSync('electron-builder.yml', 'utf8');
        expect(yaml).toMatch(/releaseType:\s*draft/);
        const wf = readFileSync('.github/workflows/release.yml', 'utf8');
        expect(wf).toMatch(/gh release create "\$GITHUB_REF_NAME"[^\n]*--draft[^\n]*\$prerelease/);
    });

    it('and the DEV channel allows prereleases in the updater', () => {
        expect(updaterConfigFor('dev').allowPrerelease).toBe(true);
    });

    it('while the STABLE channel does not — it sees full releases only', () => {
        expect(updaterConfigFor('stable').allowPrerelease).toBe(false);
    });

    it('states the link between them where somebody changing one will read it', () => {
        // A comment is not a test, but an undocumented pair is a pair somebody breaks without
        // knowing there was a pair. The assertion is that the warning exists in the file a
        // person edits.
        const yaml = readFileSync('electron-builder.yml', 'utf8');
        expect(yaml).toContain('allowPrerelease');
        expect(yaml).toContain('test/update-channels.test.ts');
    });
});

describe('orphans under the install directory', () => {
    const INSTALL = '/opt/programs/Genie';

    const proc = (pid: number, exe: string, parentPid: number | null = null) => ({ pid, executable: exe, parentPid });

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

    it('never includes our own CHILD processes — Electron\'s renderer, GPU and utility are Genie.exe too', () => {
        /**
         * Measured in the Windows VM, 2026-10-10 18:12: the installed app's §7.2 report named
         * THREE Genie.exe processes "running from the install directory" that "had to be
         * stopped" — its own renderer, GPU and network-service children. It killed them, the
         * window went blank mid-install, and the driver lost its page. Our own pid was excluded;
         * our own TREE was not. Children and grandchildren of the upgrading process are the
         * upgrading process, and `quitAndInstall` ends them in order.
         */
        const own = 42;
        const found = orphansUnder(
            [
                proc(own, '/opt/programs/Genie/Genie.exe', 1),
                proc(43, '/opt/programs/Genie/Genie.exe', own), // renderer
                proc(44, '/opt/programs/Genie/Genie.exe', own), // gpu
                proc(45, '/opt/programs/Genie/Genie.exe', 43), // a grandchild (utility under the renderer)
                // POSITIVE CONTROLS: a console host left by a PREVIOUS Genie (parent long gone,
                // reparented to 1) and a Genie.exe whose parent is some other process ARE found.
                proc(90, '/opt/programs/Genie/resources/OpenConsole.exe', 1),
                proc(91, '/opt/programs/Genie/Genie.exe', 7),
            ],
            INSTALL,
            own,
        );
        expect(found.map((p) => p.pid)).toEqual([90, 91]);
    });

    it('treats an UNKNOWN parent as outside our tree — a lister that cannot name parents hides nothing', () => {
        // `parentPid: null` is "could not tell", and a process we cannot place is still a
        // process holding our files; only a KNOWN descent from our pid earns the exclusion.
        const found = orphansUnder(
            [proc(42, '/opt/programs/Genie/Genie.exe', 1), proc(50, '/opt/programs/Genie/Genie.exe', null)],
            INSTALL,
            42,
        );
        expect(found.map((p) => p.pid)).toEqual([50]);
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

describe('the installer UPGRADES the installed Genie rather than installing beside it', () => {
    /**
     * The owner, 2026-10-10 evening: "our genie 2.0 installer needs to be able to upgrade from
     * the stable v1 beta we are on now AND the 2.0 beta.4". Measured from both repos' configs:
     * every installed Genie — `0.7.0-beta.342` and `2.0.0-beta.4` alike — was built with
     * appId `ai.tynn.genie`, productName `Genie`, per-user NSIS. Windows identifies an
     * application by its appId: a different one installs a SECOND Genie beside the old and
     * leaves the old one's uninstall entry, data and shortcuts in place. The in-place upgrade
     * is proven in the VM with the real v1 installers; this is the part a test can hold.
     */
    const yaml = () => readFileSync('electron-builder.yml', 'utf8').replace(/\r\n/g, '\n');

    it('keeps the appId every installed Genie was built with', () => {
        expect(yaml()).toMatch(/^appId:\s*ai\.tynn\.genie\s*$/m);
    });

    it('keeps the product name, so the install directory and shortcuts are the same ones', () => {
        expect(yaml()).toMatch(/^productName:\s*Genie\s*$/m);
    });

    it('is a per-user install like every installed Genie — a per-machine one cannot replace it', () => {
        expect(yaml()).toMatch(/^\s*perMachine:\s*false\s*$/m);
    });

    it('ships a version an installed 2.0.0-beta.4 will take, or the dev placeholder', () => {
        // electron-updater compares with semver; `2.0.0-beta.4` is what the newest installed
        // Genie reports, so the first Genie 2 release must sort above it — and `0.0.0` is the
        // dev tree, never released (the release bump is a deliberate commit).
        const { version } = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string };
        expect(version === '0.0.0' || releasesAbove(version, '2.0.0-beta.4')).toBe(true);
        // POSITIVE CONTROLS for the comparison itself.
        expect(releasesAbove('2.0.0-beta.5', '2.0.0-beta.4')).toBe(true);
        expect(releasesAbove('2.0.0', '2.0.0-beta.4')).toBe(true);
        expect(releasesAbove('2.0.0-beta.4', '2.0.0-beta.4')).toBe(false);
        expect(releasesAbove('0.7.0-beta.343', '2.0.0-beta.4')).toBe(false);
        expect(releasesAbove('2.0.0-beta.10', '2.0.0-beta.4')).toBe(true);
    });
});

/** semver "a > b" for the shapes Genie uses: MAJOR.MINOR.PATCH with an optional -beta.N. */
function releasesAbove(a: string, b: string): boolean {
    const parse = (v: string) => {
        const m = /^(\d+)\.(\d+)\.(\d+)(?:-([a-z]+)\.(\d+))?$/.exec(v);
        if (!m) throw new Error(`not a Genie version: ${v}`);
        return { core: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] === undefined ? null : { tag: m[4], n: Number(m[5]) } };
    };
    const x = parse(a), y = parse(b);
    for (let i = 0; i < 3; i += 1) if (x.core[i] !== y.core[i]) return x.core[i]! > y.core[i]!;
    if (x.pre === null) return y.pre !== null;   // a release beats the same version's prerelease
    if (y.pre === null) return false;
    if (x.pre.tag !== y.pre.tag) return x.pre.tag > y.pre.tag;
    return x.pre.n > y.pre.n;
}

describe('the release lands where the installed Genies look', () => {
    const yaml = () => readFileSync('electron-builder.yml', 'utf8').replace(/\r\n/g, '\n');

    it('publishes to Renaissance-Analytics/genie — the owner/repo baked into every installed app-update.yml', () => {
        // Measured from the old repo at both tags: `provider: github, owner: Renaissance-Analytics,
        // repo: genie`. The feed address is inside every installed copy; the release must be there.
        expect(yaml()).toMatch(/^\s*owner:\s*Renaissance-Analytics\s*$/m);
        expect(yaml()).toMatch(/^\s*repo:\s*genie\s*$/m);
    });

    it('installs one-click, as every installed Genie did', () => {
        expect(yaml()).toMatch(/^\s*oneClick:\s*true\s*$/m);
        // `allowToChangeInstallationDirectory` is an assisted-installer option; with one-click it
        // is refused by electron-builder, so its absence is part of the contract.
        expect(yaml()).not.toMatch(/allowToChangeInstallationDirectory/);
    });
});

describe('the installer lands in the directory every installed Genie already uses', () => {
    /**
     * Measured in the Windows VM, 2026-10-10 20:20: the first one-click build installed into
     * `%LOCALAPPDATA%\Programs\genie2` while every v1 lives in `Programs\Genie`; the uninstall
     * entry was reused (same appId) but the files went elsewhere. electron-builder's rule
     * (app-builder-lib `targetUtil.getWindowsInstallationDirName`): an assisted or per-machine
     * installer may use the PRODUCT name; a one-click per-user installer uses the sanitized
     * PACKAGE name. v1's package name is `genie` (Windows paths are case-insensitive, so
     * `Programs\genie` IS `Programs\Genie`). Genie 2 must therefore be named `genie` too — the
     * directory, the Electron app name and the uninstall entry all say the same thing.
     */
    it('is named genie — the package name electron-builder turns into the one-click install directory', () => {
        const { name } = JSON.parse(readFileSync('package.json', 'utf8')) as { name: string };
        expect(name).toBe('genie');
    });

    it('states the rule next to the name, so nobody renames it back for tidiness', () => {
        const yaml = readFileSync('electron-builder.yml', 'utf8');
        expect(yaml).toMatch(/getWindowsInstallationDirName/);
    });
});
