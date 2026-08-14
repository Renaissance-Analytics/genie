import { describe, expect, it } from 'vitest';
import { resolveEngineExe } from '../engine-resolve';
import type { EngineInstall } from '../toolchain-versions';

/**
 * WHICH runtime a site actually spawns (genie#207).
 *
 * The Toolchain page lets a machine hold several PHPs and pick a default, and a
 * site may pin one — but until this module existed nothing consumed either
 * choice: `serve-config.ts` returned a bare `php-cgi` and PATH decided. On the
 * reporting machine PATH held only Herd's `php.bat` shim, so the FastCGI worker
 * died instantly (genie#206) while the card said "Serving."
 *
 * So the rules asserted here are, in order:
 *   1. a site's PIN wins;
 *   2. otherwise the MACHINE DEFAULT;
 *   3. otherwise FAIL, naming what to install — never a different version, and
 *      never a bare name handed back to PATH.
 *
 * Only Genie-owned installs are selectable: a foreign one (Herd, XAMPP, nvm) is
 * detected for AWARENESS and can be upgraded or removed underneath a running
 * site, which is exactly what makes it unusable as a site's runtime.
 */

const GENIE_84: EngineInstall = {
    tool: 'php',
    version: '8.4.24',
    dir: 'C:\\gd\\toolchain\\php\\8.4.24',
    exe: 'C:\\gd\\toolchain\\php\\8.4.24\\php.exe',
    source: 'genie',
    removable: true,
};

const GENIE_83: EngineInstall = {
    tool: 'php',
    version: '8.3.33',
    dir: 'C:\\gd\\toolchain\\php\\8.3.33',
    exe: 'C:\\gd\\toolchain\\php\\8.3.33\\php.exe',
    source: 'genie',
    removable: true,
};

/** Herd's — the machine's OTHER php, the one genie#206 was resolved to. */
const HERD_84: EngineInstall = {
    tool: 'php',
    version: '8.4.11',
    dir: 'C:\\Users\\glenn\\.config\\herd\\bin\\php84',
    exe: 'C:\\Users\\glenn\\.config\\herd\\bin\\php84\\php.exe',
    source: 'herd',
    removable: false,
};

const WIN = { platform: 'win32' as const };

describe('resolveEngineExe', () => {
    it('spawns the MACHINE DEFAULT’s real executable when the site pins nothing', () => {
        const res = resolveEngineExe({
            tool: 'php',
            bin: 'php-cgi',
            installs: [GENIE_84, GENIE_83],
            defaults: { php: '8.3.33' },
            ...WIN,
        });
        expect(res).toEqual({
            ok: true,
            version: '8.3.33',
            install: GENIE_83,
            exe: 'C:\\gd\\toolchain\\php\\8.3.33\\php-cgi.exe',
        });
    });

    it('lets the site’s PIN beat the machine default', () => {
        const res = resolveEngineExe({
            tool: 'php',
            bin: 'php-cgi',
            pinned: '8.4.24',
            installs: [GENIE_84, GENIE_83],
            defaults: { php: '8.3.33' },
            ...WIN,
        });
        expect(res.ok && res.version).toBe('8.4.24');
        expect(res.ok && res.exe).toBe('C:\\gd\\toolchain\\php\\8.4.24\\php-cgi.exe');
    });

    it('reads a pin that names a LINE (8.3) as the newest install in it', () => {
        const older: EngineInstall = { ...GENIE_83, version: '8.3.11', dir: 'd', exe: 'd\\php.exe' };
        const res = resolveEngineExe({
            tool: 'php',
            bin: 'php-cgi',
            pinned: '8.3',
            installs: [GENIE_84, older, GENIE_83],
            defaults: { php: '8.4.24' },
            ...WIN,
        });
        expect(res.ok && res.version).toBe('8.3.33');
    });

    it('FAILS a missing pin naming the version and what IS installed — never another runtime', () => {
        const res = resolveEngineExe({
            tool: 'php',
            bin: 'php-cgi',
            pinned: '8.2',
            installs: [GENIE_84, GENIE_83],
            defaults: { php: '8.4.24' },
            ...WIN,
        });
        expect(res.ok).toBe(false);
        const error = res.ok ? '' : res.error;
        expect(error).toContain('PHP 8.2');
        // The two it COULD use are named, so the fix is a choice not a hunt…
        expect(error).toContain('8.4.24');
        expect(error).toContain('8.3.33');
        // …and it says where to go, like the php-cgi failure already does.
        expect(error).toContain('Settings → Toolchain');
    });

    it('refuses to pin a FOREIGN install — Herd can change it underneath the site', () => {
        const res = resolveEngineExe({
            tool: 'php',
            bin: 'php-cgi',
            pinned: '8.4.11',
            installs: [GENIE_83, HERD_84],
            defaults: { php: '8.3.33' },
            ...WIN,
        });
        expect(res.ok).toBe(false);
        // And it does NOT quietly serve on 8.3.33 instead.
        expect(res.ok ? '' : res.error).not.toContain('8.4.11\\php-cgi.exe');
    });

    it('FAILS when Genie manages no version at all, and SAYS the foreign one is not usable', () => {
        const res = resolveEngineExe({
            tool: 'php',
            bin: 'php-cgi',
            installs: [HERD_84],
            defaults: {},
            ...WIN,
        });
        expect(res.ok).toBe(false);
        const error = res.ok ? '' : res.error;
        // The user's first thought is "but I HAVE php" — answer it in the message.
        expect(error).toContain('Herd');
        expect(error).toContain('Settings → Toolchain');
    });

    it('finds the companion beside the EXE, not in the version dir (the bin/ layout)', () => {
        // A posix tarball unpacks to <version>/bin/php — `dir` is what Remove
        // deletes, `exe` is where the binaries are, and php-cgi sits beside the exe.
        const posix: EngineInstall = {
            tool: 'php',
            version: '8.3.33',
            dir: '/home/g/.genie/toolchain/php/8.3.33',
            exe: '/home/g/.genie/toolchain/php/8.3.33/bin/php',
            source: 'genie',
            removable: true,
        };
        const res = resolveEngineExe({
            tool: 'php',
            bin: 'php-cgi',
            installs: [posix],
            defaults: {},
            platform: 'linux',
        });
        expect(res.ok && res.exe).toBe('/home/g/.genie/toolchain/php/8.3.33/bin/php-cgi');
    });

    it('defaults to the PRIMARY binary, and refuses a bin the scanner never proved', () => {
        const primary = resolveEngineExe({
            tool: 'php',
            installs: [GENIE_83],
            defaults: {},
            ...WIN,
        });
        expect(primary.ok && primary.exe).toBe(GENIE_83.exe);

        const bogus = resolveEngineExe({
            tool: 'php',
            bin: 'php-fpm',
            installs: [GENIE_83],
            defaults: {},
            ...WIN,
        });
        expect(bogus.ok).toBe(false);
    });

    it('ignores another language’s installs entirely', () => {
        const node: EngineInstall = {
            tool: 'node',
            version: '24.19.0',
            dir: 'C:\\gd\\toolchain\\node\\24.19.0',
            exe: 'C:\\gd\\toolchain\\node\\24.19.0\\node.exe',
            source: 'genie',
            removable: true,
        };
        const res = resolveEngineExe({
            tool: 'php',
            bin: 'php-cgi',
            installs: [node],
            defaults: { php: '8.3.33' },
            ...WIN,
        });
        expect(res.ok).toBe(false);
    });
});
