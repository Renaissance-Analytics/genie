import { describe, expect, it } from 'vitest';
import { refreshedHostEnv, mergePathEntries } from '../host-env-refresh';

/**
 * A NEWLY-INSTALLED CLI IS VISIBLE IN TERMINALS WITHOUT A REBOOT.
 *
 * The owner: *"WE need a way to do a hard restart of the pty host so that
 * terminals can reload when we have cli installs and stuff that needs to be
 * available in the terminals. (right now, we have to reboot the machine to make
 * stuff like that apply)"* — and then: *"same in npm and any cli tools that get
 * installed."*
 *
 * WHY A REBOOT IS CURRENTLY THE ONLY WAY. The detached pty host is spawned with
 * `...process.env` — GENIE's environment, captured when Genie started. Every
 * terminal inherits it. An installer that adds to `PATH` writes the REGISTRY (or
 * a shell profile); it cannot reach into a running process. So:
 *
 *   - the new tool is not on the host's PATH, so no terminal can see it;
 *   - restarting the host does not help, because it is respawned from the same
 *     stale `process.env`;
 *   - restarting Genie does not help either, if Genie itself was started before
 *     the install — it inherited the old PATH from explorer.exe.
 *
 * Only a reboot reliably replaces the whole chain, which is exactly what the
 * owner is doing and should not have to.
 *
 * So the host is restarted with an environment read FRESH from the OS rather than
 * inherited. This is the composition half: given what the OS says now and what
 * Genie is holding, what should the new host actually get?
 */
describe('mergePathEntries', () => {
    it('keeps every entry the OS now reports', () => {
        const merged = mergePathEntries(['/usr/bin'], ['/usr/bin', '/opt/gh/bin'], ':');
        expect(merged).toContain('/opt/gh/bin');
    });

    it('does not duplicate an entry present in both', () => {
        // A PATH that doubles in length on every restart is how a machine ends up
        // with a 32k PATH it cannot spawn anything from.
        const merged = mergePathEntries(['/usr/bin'], ['/usr/bin'], ':');
        expect(merged.split(':').filter((p) => p === '/usr/bin')).toHaveLength(1);
    });

    it('PREFERS the freshly-read entries, in their order', () => {
        // The OS is the authority on what is installed. An inherited PATH that
        // outranked it would keep an old version of a tool winning after an
        // in-place upgrade.
        const merged = mergePathEntries(['/old/node'], ['/new/node', '/old/node'], ':');
        expect(merged.indexOf('/new/node')).toBeLessThan(merged.indexOf('/old/node'));
    });

    it('KEEPS process-only entries the OS cannot know about', () => {
        // Genie injects per-workspace and toolchain dirs into its own PATH at
        // runtime. Those exist in no registry key, so taking the OS PATH verbatim
        // would silently strip the toolchain Genie just installed — trading one
        // invisible-tool bug for a worse one.
        const merged = mergePathEntries(
            ['/usr/bin', '/genie/toolchain/node/22/bin'],
            ['/usr/bin', '/opt/gh/bin'],
            ':',
        );
        expect(merged).toContain('/genie/toolchain/node/22/bin');
        expect(merged).toContain('/opt/gh/bin');
    });

    it('ignores empty segments rather than emitting a bare separator', () => {
        // A trailing `;` on Windows PATH is common and turns into an empty entry,
        // which some spawners resolve as the current directory.
        const merged = mergePathEntries(['/usr/bin', ''], ['', '/opt/gh/bin'], ':');
        expect(merged.split(':')).not.toContain('');
    });

    it('is case-insensitive about duplicates on Windows', () => {
        // `C:\Program Files\Git` and `C:\PROGRAM FILES\GIT` are the same directory;
        // emitting both grows PATH without adding anything.
        const merged = mergePathEntries(
            ['C:\\Program Files\\Git'],
            ['C:\\PROGRAM FILES\\GIT', 'C:\\gh'],
            ';',
        );
        expect(merged.split(';').length).toBe(2);
        expect(merged).toContain('C:\\gh');
    });
});

describe('refreshedHostEnv', () => {
    const inherited = { PATH: '/usr/bin', GENIE_X: 'keep-me' };

    it('replaces PATH with the merged one and keeps everything else', () => {
        const out = refreshedHostEnv({
            inherited,
            osPath: '/usr/bin:/opt/gh/bin',
            pathKey: 'PATH',
            sep: ':',
        });
        expect(out.PATH).toContain('/opt/gh/bin');
        expect(out.GENIE_X).toBe('keep-me'); // never drop Genie's own wiring
    });

    it('leaves the environment ALONE when the OS path cannot be read', () => {
        // "Cannot tell" must not mean "wipe PATH". A failed registry read that
        // emptied the host's PATH would leave a machine where no terminal can
        // spawn anything at all — far worse than a tool being invisible.
        const out = refreshedHostEnv({ inherited, osPath: null, pathKey: 'PATH', sep: ':' });
        expect(out).toEqual(inherited);
    });

    it('leaves it alone when the OS reports an empty path', () => {
        const out = refreshedHostEnv({ inherited, osPath: '   ', pathKey: 'PATH', sep: ':' });
        expect(out).toEqual(inherited);
    });

    it('writes back under the SAME key casing the environment already uses', () => {
        // Windows env is case-insensitive but a plain JS object is not: writing
        // `PATH` next to an existing `Path` yields two keys, and which one a
        // spawned process honours is luck.
        const out = refreshedHostEnv({
            inherited: { Path: 'C:\\Windows', GENIE_X: 'keep-me' },
            osPath: 'C:\\Windows;C:\\gh',
            pathKey: 'Path',
            sep: ';',
        });
        expect(Object.keys(out).filter((k) => k.toLowerCase() === 'path')).toHaveLength(1);
        expect(out.Path).toContain('C:\\gh');
    });
});

/**
 * Asking the OS what PATH is NOW. Kept as argv so the spawn stays with the
 * caller, but the argv itself carries two decisions worth pinning — each one is
 * the difference between refreshing the environment and only appearing to.
 */
import { osPathArgv } from '../host-env-refresh';

describe('osPathArgv', () => {
    it('reads BOTH Windows hives, machine before user', () => {
        // Windows composes Machine + User at logon. Reading only one gives a PATH
        // no real console ever has, and reading them in the other order lets a
        // user entry shadow a machine one differently here than it would in a
        // fresh terminal.
        const { command, args } = osPathArgv('win32', undefined);
        expect(command).toMatch(/powershell/i);
        const script = args.join(' ');
        expect(script).toContain("'Machine'");
        expect(script).toContain("'User'");
        expect(script.indexOf("'Machine'")).toBeLessThan(script.indexOf("'User'"));
    });

    it('does not let a user profile change the answer on Windows', () => {
        // -NoProfile: a PowerShell profile that mutates PATH would make this
        // report that profile's PATH rather than the machine's.
        expect(osPathArgv('win32', undefined).args).toContain('-NoProfile');
    });

    it('uses a LOGIN shell on posix', () => {
        // THE load-bearing flag. Without -l the profile that defines the new
        // tool's PATH is never sourced, so this returns the PATH we already have
        // — a refresh that silently refreshes nothing.
        const { command, args } = osPathArgv('darwin', '/bin/zsh');
        expect(command).toBe('/bin/zsh');
        expect(args).toContain('-l');
    });

    it('falls back to /bin/sh when no shell is known', () => {
        expect(osPathArgv('linux', undefined).command).toBe('/bin/sh');
    });
});
