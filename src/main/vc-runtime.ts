import { join } from 'node:path';
import { vcRuntimeAtLeast } from '../core/php-versions.js';
import type { Fetched } from './php-versions.js';
import type { CommandRunner } from './toolchain-prober.js';

/**
 * THE VISUAL C++ RUNTIME, AT LEAST THE VERSION A BUILD NEEDS (Tynn #1066).
 *
 * Measured on a fresh Windows VM, 2026-11-26: php-8.6.0-nts-Win32-vs18-x64 would not start — "VCRUNTIME140.dll 14.44 is
 * not compatible with this PHP build linked with 14.51". The runtime was PRESENT, so T1's install ("already installed")
 * did nothing. Here its version is read from the DLL itself (System32\vcruntime140.dll, what php-cgi loads).
 *
 * When it is older than the build's toolset needs, Microsoft's own redistributable is used — never winget (Windows Server
 * has none: the same VM said `spawn winget ENOENT`; the owner: "don't rely on winget"). It is the permalink for the
 * current v14 redistributable, `https://aka.ms/vc14/vc_redist.x64.exe`. Microsoft publishes no checksum for it, so it is
 * run only once its AUTHENTICODE signature is Valid and its signer is Microsoft Corporation — any other file is never
 * run. Installing it needs an administrator, so it is never run on the way through a PHP install: that install stops
 * with the redistributable fetched and checked, and the person's own click on "Install it (asks for administrator)" runs
 * it (`install: true`), elevated, its exit code read. The DLL is read again after; it decides, never an exit code alone.
 */

export const VC_REDIST_URL = 'https://aka.ms/vc14/vc_redist.x64.exe';

export interface VcRuntimePorts {
    readonly run: CommandRunner;
    readonly systemRoot: string;
    readonly progress?: (step: string) => void;
    /** Where the redistributable is saved to be run. */
    readonly tempDir?: string;
    readonly download?: (url: string) => Promise<Fetched<Uint8Array>>;
    readonly writeFile?: (path: string, bytes: Uint8Array) => void;
}

const psQuote = (s: string) => `'${s.replace(/'/g, "''")}'`;
const ps = (run: CommandRunner, command: string) => run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command]);

/** This machine's VCRUNTIME140 version (`14.44.35211.0`), read from the DLL php-cgi loads; `null` when unread. */
export async function dllVersion(run: CommandRunner, systemRoot: string): Promise<string | null> {
    try {
        const r = await ps(run, `(Get-Item -LiteralPath ${psQuote(join(systemRoot, 'System32', 'vcruntime140.dll'))}).VersionInfo.FileVersion`);
        const v = r.stdout.trim().split(/\s+/)[0] ?? '';
        return /^\d+\.\d+/.test(v) ? v : null;
    } catch {
        return null;
    }
}

/** Microsoft's redistributable, downloaded and its signature checked: its path and version, or why not. Never run here. */
async function prepare(ports: VcRuntimePorts): Promise<{ ok: true; exe: string; version: string } | { ok: false; reason: string }> {
    if (!ports.download || !ports.writeFile || !ports.tempDir) return { ok: false, reason: 'Genie cannot download it here' };
    const got = await ports.download(VC_REDIST_URL);
    if (!got.ok) return { ok: false, reason: `${VC_REDIST_URL} could not be downloaded (${got.error})` };
    const exe = join(ports.tempDir, 'vc_redist.x64.exe');
    try {
        ports.writeFile(exe, got.body);
    } catch (error) {
        return { ok: false, reason: `${exe} could not be written (${error instanceof Error ? error.message : String(error)})` };
    }
    let signature = '';
    try {
        signature = (await ps(ports.run, `$s = Get-AuthenticodeSignature -LiteralPath ${psQuote(exe)}; "$($s.Status)|$($s.SignerCertificate.Subject)"`)).stdout.trim();
    } catch (error) {
        return { ok: false, reason: `its signature could not be read (${error instanceof Error ? error.message : String(error)})` };
    }
    const [status, subject = ''] = signature.split('|');
    if (status !== 'Valid' || !/^CN=Microsoft Corporation,/.test(subject)) return { ok: false, reason: `Microsoft's redistributable's Authenticode signature is not a valid Microsoft one (${signature.slice(0, 160) || 'none'}), so it was not run` };
    let version = '';
    try {
        version = (await ps(ports.run, `(Get-Item -LiteralPath ${psQuote(exe)}).VersionInfo.ProductVersion`)).stdout.trim().split(/\s+/)[0] ?? '';
    } catch {
        version = '';
    }
    return { ok: true, exe, version };
}

/** The installer's exit codes that mean it is in: 0, and 3010 / 1641 (in, after a restart); 1638: a newer one already is. */
const RESTART = new Set([3010, 1641]);

export async function ensureVcRuntimeAtLeast(min: string, ports: VcRuntimePorts, options: { install: boolean }): Promise<{ ok: true } | { ok: false; reason: string }> {
    const before = await dllVersion(ports.run, ports.systemRoot);
    if (before !== null && vcRuntimeAtLeast(before, min)) return { ok: true };
    const has = `this machine's vcruntime140.dll is ${before ?? 'not readable'}`;
    const ready = await prepare(ports);
    if (!ready.ok) return { ok: false, reason: `${has}; ${ready.reason}` };
    if (!options.install) return { ok: false, reason: `${has}; Microsoft's signed redistributable ${ready.version || ''} is ready to install`.replace(/ {2}/g, ' ') };
    ports.progress?.(`Installing the Microsoft Visual C++ runtime ${ready.version} — Windows asks for an administrator`);
    let exit: number;
    try {
        const r = await ps(ports.run, `$ErrorActionPreference='Stop'; $p = Start-Process -Wait -PassThru -Verb RunAs -FilePath ${psQuote(ready.exe)} -ArgumentList @('/install','/quiet','/norestart'); if ($null -eq $p) { exit 1 }; exit $p.ExitCode`);
        exit = r.exitCode;
    } catch (error) {
        return { ok: false, reason: `${has}; the redistributable could not be run (${error instanceof Error ? error.message : String(error)})` };
    }
    const after = await dllVersion(ports.run, ports.systemRoot);
    if (after !== null && vcRuntimeAtLeast(after, min)) return { ok: true };
    if (RESTART.has(exit)) return { ok: false, reason: `the Microsoft Visual C++ runtime ${ready.version} is installed, and Windows must restart before it is the one loaded (vcruntime140.dll is still ${after ?? 'not readable'})` };
    if (exit === 1602 || exit === 1223) return { ok: false, reason: `the administrator prompt was declined; ${has}` };
    return { ok: false, reason: `the redistributable ${ready.version} exited ${exit}; vcruntime140.dll is still ${after ?? 'not readable'}` };
}
