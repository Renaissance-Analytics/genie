import { describe, expect, it } from 'vitest';
import { staleManagedInis } from '../toolchain-manager';
import { joinFor, phpIniContents, type EngineInstall } from '../toolchain-versions';

/**
 * A `php.ini` Genie wrote goes STALE and nothing ever rewrites it.
 *
 * Found on the reporting machine, and only because the PATH fix made Genie's own
 * PHP actually get used: every `php` invocation printed
 *
 *   Warning: PHP Startup: Unable to load dynamic library 'bcmath'
 *
 * `bcmath` is compiled INTO the Windows build, so the `extension=bcmath` line
 * bought nothing but that warning — which is why it was removed from
 * PHP_INI_EXTENSIONS. But the fix only reached NEW installs: the ini already on
 * disk still names it, and its own header promises it is "rewritten when Genie
 * reinstalls this version" — which is to say, never, for a version that is
 * already there.
 *
 * That warning goes to stderr on every php invocation, so it lands in every
 * composer run, every artisan command and every site log, forever.
 *
 * Genie rewrites only the inis it OWNS. Herd's is Herd's, and a config Genie
 * edits underneath another app is the same fault this whole feature is about.
 */
const install = (source: EngineInstall['source'], dir: string): EngineInstall => ({
    tool: 'php',
    version: '8.4.24',
    dir,
    exe: `${dir}/php.exe`,
    source,
    removable: source === 'genie',
});

describe('stale Genie-written php.ini files', () => {
    it('reports an ini that no longer matches what Genie would write', () => {
        const dir = 'C:/genie/toolchain/php/8.4.24';
        const stale = staleManagedInis({
            installs: [install('genie', dir)],
            platform: 'win32',
            read: () => 'extension_dir = "x"\nextension=bcmath\n',
        });

        expect(stale).toHaveLength(1);
        // Backslash: `joinFor('win32', …)` writes a Windows path, which is what
        // the file actually has to be written to.
        expect(stale[0]!.path).toBe(joinFor('win32', dir, 'php.ini'));
        expect(stale[0]!.contents).toBe(phpIniContents(dir, 'win32'));
    });

    it('reports nothing when the ini is already current', () => {
        // Negative control: without this, "one stale ini" would pass against a
        // function that reports every install unconditionally — and a repair
        // that rewrites a correct file every time is churn, not a fix.
        const dir = 'C:/genie/toolchain/php/8.4.24';
        const stale = staleManagedInis({
            installs: [install('genie', dir)],
            platform: 'win32',
            read: () => phpIniContents(dir, 'win32'),
        });

        expect(stale).toEqual([]);
    });

    it('never touches an ini belonging to another installer', () => {
        // Herd's ini is Herd's to rewrite. Genie editing another app's config is
        // the same class of fault this feature exists to stop.
        const stale = staleManagedInis({
            installs: [install('herd', 'C:/herd/bin/php84')],
            platform: 'win32',
            read: () => 'extension=bcmath\n',
        });

        expect(stale).toEqual([]);
    });

    it('treats an unreadable ini as stale rather than throwing', () => {
        // A missing or unreadable ini is the strongest case for writing one.
        const dir = 'C:/genie/toolchain/php/8.4.24';
        const stale = staleManagedInis({
            installs: [install('genie', dir)],
            platform: 'win32',
            read: () => {
                throw new Error('ENOENT');
            },
        });

        expect(stale).toHaveLength(1);
    });

    it('ignores languages that have no Genie-written config', () => {
        const stale = staleManagedInis({
            installs: [{ ...install('genie', 'C:/genie/toolchain/node/22.23.2'), tool: 'node' }],
            platform: 'win32',
            read: () => 'whatever',
        });

        expect(stale).toEqual([]);
    });
});

/**
 * A PECL extension that is PRESENT ON DISK must survive the ini refresh.
 *
 * `redis` is not in the official Windows build, so it cannot live in
 * PHP_INI_EXTENSIONS: on a machine without the DLL that line would fail to load
 * and print a warning on every php invocation — the exact fault this whole
 * refresh feature exists to remove, and it would also fail the install gate,
 * since PHP_REQUIRED_MODULES aliases the same list.
 *
 * But once the DLL IS beside the binary, the ini must name it. Without this the
 * refresh silently DELETES `extension=redis` on the next launch and a working
 * site starts returning `Class "Redis" not found` again — which is how
 * `tynn.gen` spent a week at HTTP 500 (genie#392).
 *
 * So the rule is presence, not preference: an optional extension is enabled iff
 * its DLL is on disk. `phpIniContents` stays PURE — the caller looks.
 */
describe('optional PECL extensions present on disk', () => {
    it('names an optional extension when its DLL is beside the binary', () => {
        const ini = phpIniContents('C:/genie/toolchain/php/8.4.24', 'win32', null, ['redis']);
        expect(ini).toContain('extension=redis');
        // POSITIVE CONTROL: prove the assertion can fail — the same call without
        // it must NOT name redis, or the test above passes on any string.
        expect(phpIniContents('C:/genie/toolchain/php/8.4.24', 'win32', null, [])).not.toContain(
            'extension=redis',
        );
    });

    it('does not rewrite an ini that already names the optional extension', () => {
        const dir = 'C:/genie/toolchain/php/8.4.24';
        const current = phpIniContents(dir, 'win32', null, ['redis']);
        const stale = staleManagedInis({
            installs: [install('genie', dir)],
            platform: 'win32',
            read: () => current,
            extrasFor: () => ['redis'],
        });
        expect(stale).toEqual([]);
    });

    it('REPORTS an ini that is missing an optional extension the machine has', () => {
        const dir = 'C:/genie/toolchain/php/8.4.24';
        const stale = staleManagedInis({
            installs: [install('genie', dir)],
            platform: 'win32',
            read: () => phpIniContents(dir, 'win32', null, []),
            extrasFor: () => ['redis'],
        });
        expect(stale).toHaveLength(1);
        expect(stale[0]!.contents).toContain('extension=redis');
    });
});
