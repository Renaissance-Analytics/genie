import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'vitest';

/*
 * CAN THIS MACHINE CREATE A FILE SYMLINK? A standard Windows user without Developer Mode cannot: `symlink` fails EPERM
 * (the beta.60 suite on Azure, genie a standard user: test/p4-artboard-file-sources.test.ts failed in its SETUP). An
 * Administrator can, as on GitHub's runner; so can every POSIX user. A row that needs one runs where it can and is
 * SKIPPED, by name and with the reason, where it cannot: never a silent pass, and never a failure of the setup read as a
 * failure of the guard. A junction (`symlink(target, path, 'junction')`) needs no privilege, so a directory link is
 * tested with one on Windows, everywhere.
 */
export const fileSymlinks: { readonly ok: true } | { readonly ok: false; readonly code: string } = (() => {
    const probe = mkdtempSync(join(tmpdir(), 'genie2-symprobe-'));
    try {
        writeFileSync(join(probe, 't'), 'x');
        symlinkSync(join(probe, 't'), join(probe, 'l'), 'file');
        return { ok: true } as const;
    } catch (error) {
        return { ok: false, code: String((error as NodeJS.ErrnoException).code ?? error) } as const;
    } finally {
        rmSync(probe, { recursive: true, force: true });
    }
})();

/** The reason a file-symlink row is skipped here, or `null` where it runs. */
export const fileSymlinkSkipReason: string | null = fileSymlinks.ok
    ? null
    : `SKIPPED: this machine cannot create a file symlink (${fileSymlinks.code}; a standard Windows user without Developer Mode cannot). The row runs where it can, as on CI.`;

/**
 * `it` for a row that needs a file symlink: run where one can be made; elsewhere skipped, its name carrying the reason so
 * the report shows why. Same arguments as `it`.
 */
export function itWithFileSymlinks(name: string, fn: () => unknown, timeout?: number): void {
    if (fileSymlinkSkipReason === null) it(name, fn as () => Promise<void>, timeout);
    else it.skip(`${name} [${fileSymlinkSkipReason}]`, fn as () => Promise<void>);
}
