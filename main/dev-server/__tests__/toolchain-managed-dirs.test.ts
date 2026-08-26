import { describe, expect, it } from 'vitest';
import { managedPathDirs } from '../toolchain-manager';
import type { EngineInstall } from '../toolchain-versions';

/**
 * WHICH directories a repair must put first.
 *
 * Found by inspecting the reporting machine instead of trusting the design. The
 * language runtimes live under `<userData>/toolchain/<tool>/<version>` —
 * `php/8.4.24`, `node/22.23.2`, `python/3.14.7` were all present — while
 * `<userData>/tools`, the only directory the first cut of the repair prepended,
 * did not exist at all. That repair would have reported success and left `php`
 * resolving to Herd.
 *
 * This is the SAME split genie#212 fixed once already (the wizard installing to
 * `tools/` while the page scanned `toolchain/`), which is why it gets a test of
 * its own rather than a comment.
 *
 * The dirs are derived from the SAME resolution sites use — installs + machine
 * defaults — so what a terminal finds on PATH and what a site spawns are the
 * same binary. Deriving them a second way is how those two drift apart.
 */
const genie = (tool: EngineInstall['tool'], version: string, dir: string, exe: string): EngineInstall => ({
    tool,
    version,
    dir,
    exe,
    source: 'genie',
    removable: true,
});

const foreign = (tool: EngineInstall['tool'], version: string, dir: string, exe: string): EngineInstall => ({
    tool,
    version,
    dir,
    exe,
    source: 'herd',
    removable: false,
});

describe('the directories a toolchain repair must put first', () => {
    it('returns the ENGINE dir of each default version, not a `tools` dir', () => {
        const dirs = managedPathDirs({
            installs: [
                genie('php', '8.4.24', 'C:/genie/toolchain/php/8.4.24', 'C:/genie/toolchain/php/8.4.24/php.exe'),
                genie('node', '22.23.2', 'C:/genie/toolchain/node/22.23.2', 'C:/genie/toolchain/node/22.23.2/node.exe'),
            ],
            defaults: { php: '8.4.24', node: '22.23.2' },
            platform: 'win32',
            toolsDir: 'C:/genie/tools',
            exists: () => false, // the `tools` dir does not exist on this machine
        });

        expect(dirs).toContain('C:/genie/toolchain/php/8.4.24');
        expect(dirs).toContain('C:/genie/toolchain/node/22.23.2');
        expect(dirs).not.toContain('C:/genie/tools');
    });

    it('includes the host-tools dir when it DOES exist', () => {
        // Positive control for the assertion above: without this, "tools is
        // absent" would pass against a function that never returns it at all.
        const dirs = managedPathDirs({
            installs: [],
            defaults: {},
            platform: 'win32',
            toolsDir: 'C:/genie/tools',
            exists: () => true,
        });

        expect(dirs).toContain('C:/genie/tools');
    });

    it('never puts a FOREIGN install on PATH, even as the only one for a tool', () => {
        // Herd's PHP is the only PHP here. Genie still must not hand it to the
        // terminals and sites it spawns: a runtime another app can upgrade or
        // uninstall underneath a running site is not one a site may depend on.
        const dirs = managedPathDirs({
            installs: [foreign('php', '8.4.0', 'C:/herd/bin/php84', 'C:/herd/bin/php84/php.exe')],
            defaults: { php: '8.4.0' },
            platform: 'win32',
            toolsDir: 'C:/genie/tools',
            exists: () => false,
        });

        expect(dirs).toEqual([]);
    });

    it('follows the machine default when several versions are installed', () => {
        const dirs = managedPathDirs({
            installs: [
                genie('php', '8.3.33', 'C:/genie/toolchain/php/8.3.33', 'C:/genie/toolchain/php/8.3.33/php.exe'),
                genie('php', '8.4.24', 'C:/genie/toolchain/php/8.4.24', 'C:/genie/toolchain/php/8.4.24/php.exe'),
            ],
            defaults: { php: '8.3.33' },
            platform: 'win32',
            toolsDir: 'C:/genie/tools',
            exists: () => false,
        });

        expect(dirs).toEqual(['C:/genie/toolchain/php/8.3.33']);
    });

    it('uses the exe’s own directory, so a posix `bin/` layout lands on PATH', () => {
        // `dir` is the version directory Remove deletes; a tarball puts the
        // executables in its `bin/` subdirectory. Prepending `dir` there would
        // put a directory with no executables in it at the front of PATH.
        const dirs = managedPathDirs({
            installs: [
                genie('node', '22.23.2', '/home/x/.genie/toolchain/node/22.23.2', '/home/x/.genie/toolchain/node/22.23.2/bin/node'),
            ],
            defaults: { node: '22.23.2' },
            platform: 'linux',
            toolsDir: '/home/x/.genie/tools',
            exists: () => false,
        });

        expect(dirs).toEqual(['/home/x/.genie/toolchain/node/22.23.2/bin']);
    });
});
