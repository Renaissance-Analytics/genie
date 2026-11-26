import { join } from 'node:path';
import { vcRuntimeAtLeast } from '../core/php-versions.js';
import type { CommandRunner } from './toolchain-prober.js';

/**
 * THE VISUAL C++ RUNTIME, AT LEAST THE VERSION A BUILD NEEDS (Tynn #1066).
 *
 * Measured on a fresh Windows VM, 2026-11-26: php-8.6.0-nts-Win32-vs18-x64 would not start — "VCRUNTIME140.dll 14.44 is
 * not compatible with this PHP build linked with 14.51". The runtime was PRESENT, so T1's install ("already installed")
 * did nothing. Here its version is read from the DLL itself (System32\vcruntime140.dll, what php-cgi loads); when it is
 * older than the build's toolset needs, winget brings Microsoft.VCRedist.2015+.x64 up — the same package and the same
 * consented channel T1 installs it through, the click on Install being the consent — and the DLL is read again. Judged
 * by the DLL, never by winget's exit code.
 */

const PACKAGE = 'Microsoft.VCRedist.2015+.x64';
const WINGET_QUIET = ['-e', '--silent', '--accept-package-agreements', '--accept-source-agreements', '--disable-interactivity'];

async function dllVersion(run: CommandRunner, systemRoot: string): Promise<string | null> {
    const dll = join(systemRoot, 'System32', 'vcruntime140.dll').replace(/'/g, "''");
    try {
        const r = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-Item -LiteralPath '${dll}').VersionInfo.FileVersion`]);
        const v = r.stdout.trim().split(/\s+/)[0] ?? '';
        return /^\d+\.\d+/.test(v) ? v : null;
    } catch {
        return null;
    }
}

export async function ensureVcRuntimeAtLeast(min: string, ports: { run: CommandRunner; systemRoot: string; progress?: (step: string) => void }): Promise<{ ok: true } | { ok: false; reason: string }> {
    const before = await dllVersion(ports.run, ports.systemRoot);
    if (before !== null && vcRuntimeAtLeast(before, min)) return { ok: true };
    ports.progress?.(`Updating the Microsoft Visual C++ runtime (${before ?? 'none'}) to ${min} or newer — Windows may ask for permission`);
    const tried: string[] = [];
    for (const args of [['upgrade', '--id', PACKAGE, ...WINGET_QUIET], ['install', '--id', PACKAGE, '--force', ...WINGET_QUIET]]) {
        try {
            tried.push(`winget ${args[0]} exited ${(await ports.run('winget', args)).exitCode}`);
        } catch (error) {
            tried.push(`winget ${args[0]} could not run (${error instanceof Error ? error.message : String(error)})`);
        }
        const now = await dllVersion(ports.run, ports.systemRoot);
        if (now !== null && vcRuntimeAtLeast(now, min)) return { ok: true };
    }
    const after = await dllVersion(ports.run, ports.systemRoot);
    return { ok: false, reason: `this machine's vcruntime140.dll is ${after ?? 'not readable'} (${tried.join('; ')})` };
}
