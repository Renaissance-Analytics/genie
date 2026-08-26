import { describe, expect, it } from 'vitest';
import { staleManagedInis } from '../toolchain-manager';
import { phpIniContents, type EngineInstall } from '../toolchain-versions';

/**
 * THE HALF THAT WAS STILL MANUAL — and the regression it caused.
 *
 * beta.270 made PATH precedence AUTOMATIC: Genie's own toolchain now wins for
 * everything it spawns, applied at every startup. But the fix for that
 * toolchain's stale `php.ini` stayed behind a button (Settings -> Toolchain ->
 * Check and repair).
 *
 * For anyone who did not click it, the upgrade made things WORSE. Reported the
 * same day from another workspace: `composer require laravel/passport` began
 * failing with
 *
 *     lcobucci/jwt 5.6.0 requires ext-sodium * -> it is missing from your system
 *
 * The reporter read it as two faults — a missing extension and a bogus `bcmath`
 * path. It is ONE: the on-disk ini predates the current extension list.
 *
 *     code today : curl … sockets, SODIUM, sqlite3, zip
 *     on disk    : BCMATH, curl … sockets, sqlite3, zip
 *
 * `php_sodium.dll` was present in `ext/` the whole time; nothing asked for it.
 * And `bcmath` is compiled into the Windows build, so its `extension=` line only
 * ever produced a startup warning on stderr — which corrupts the output of
 * anything parsing stdout/stderr, exactly as the reporter said.
 *
 * So the ini refresh has to run where precedence runs: at STARTUP. It is
 * idempotent and costs a file compare per PHP install. Leaving it manual means
 * Genie switches the machine onto an interpreter and then declines to configure
 * it until asked.
 */
const install = (dir: string): EngineInstall => ({
    tool: 'php',
    version: '8.4.24',
    dir,
    exe: `${dir}/php.exe`,
    source: 'genie',
    removable: true,
});

describe('the ini a startup refresh must rewrite', () => {
    const DIR = 'C:/genie/toolchain/php/8.4.24';

    it('treats the shipped-with-beta.269 ini as STALE', () => {
        // Verbatim shape of the ini found on the reporting machine: bcmath
        // present, sodium absent.
        const onDisk = [
            'extension_dir = "C:/genie/toolchain/php/8.4.24/ext"',
            'extension=bcmath',
            'extension=curl',
            'extension=sockets',
            'extension=sqlite3',
            'extension=zip',
        ].join('\n');

        const stale = staleManagedInis({
            installs: [install(DIR)],
            platform: 'win32',
            read: () => onDisk,
        });

        expect(stale).toHaveLength(1);
        // The rewrite is what unbreaks Passport: sodium in, bcmath out.
        expect(stale[0]!.contents).toContain('extension=sodium');
        expect(stale[0]!.contents).not.toContain('extension=bcmath');
    });

    it('rewrites nothing once the ini is current', () => {
        // Negative control, and the reason this is safe to run at every startup:
        // a machine already correct is not touched, so this cannot churn a file
        // on every launch.
        const stale = staleManagedInis({
            installs: [install(DIR)],
            platform: 'win32',
            read: () => phpIniContents(DIR, 'win32'),
        });

        expect(stale).toEqual([]);
    });
});
