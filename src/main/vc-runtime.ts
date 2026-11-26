import { join } from 'node:path';
import { vcRuntimeAtLeast } from '../core/php-versions.js';
import type { Fetched } from './php-versions.js';
import type { CommandRunner } from './toolchain-prober.js';

/**
 * THE VISUAL C++ RUNTIME, AT LEAST THE VERSION A BUILD NEEDS (Tynn #1066).
 *
 * Measured on a fresh Windows VM, 2026-11-26: php-8.6.0-nts-Win32-vs18-x64 would not start — "VCRUNTIME140.dll 14.44 is
 * not compatible with this PHP build linked with 14.51". The runtime was PRESENT, so T1's install ("already installed")
 * did nothing. Here its version is read from the DLL itself (System32\vcruntime140.dll, what php-cgi loads); when it is
 * older than the build's toolset needs, it is brought up — the click on Install being the consent — and the DLL is read
 * again. Judged by the DLL, never by an installer's exit code.
 *
 * - winget first: Microsoft.VCRedist.2015+.x64, the package and channel T1 installs it through;
 * - no winget (Windows Server has none — the same VM: `spawn winget ENOENT`): Microsoft's own permalink for the current
 *   v14 redistributable, `https://aka.ms/vc14/vc_redist.x64.exe`. Microsoft publishes no checksum for it, so it is run
 *   only once its AUTHENTICODE signature is Valid and its signer is Microsoft Corporation — any other file is never run.
 *   It asks Windows for permission itself (`-Verb RunAs`).
 */

const PACKAGE = 'Microsoft.VCRedist.2015+.x64';
const WINGET_QUIET = ['-e', '--silent', '--accept-package-agreements', '--accept-source-agreements', '--disable-interactivity'];
export const VC_REDIST_URL = 'https://aka.ms/vc14/vc_redist.x64.exe';

export interface VcRuntimePorts {
    readonly run: CommandRunner;
    readonly systemRoot: string;
    readonly progress?: (step: string) => void;
    /** Where the redistributable is saved to be run; with `download` and `writeFile`, the fallback when winget is absent. */
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

/** Microsoft's redistributable, downloaded, signature-checked, run. `null` when it ran; else why not. */
async function viaMicrosoftDownload(ports: VcRuntimePorts): Promise<string | null> {
    if (!ports.download || !ports.writeFile || !ports.tempDir) return 'no download is wired here';
    const got = await ports.download(VC_REDIST_URL);
    if (!got.ok) return `${VC_REDIST_URL} could not be downloaded (${got.error})`;
    const exe = join(ports.tempDir, 'vc_redist.x64.exe');
    try {
        ports.writeFile(exe, got.body);
    } catch (error) {
        return `${exe} could not be written (${error instanceof Error ? error.message : String(error)})`;
    }
    let signature = '';
    try {
        signature = (await ps(ports.run, `$s = Get-AuthenticodeSignature -LiteralPath ${psQuote(exe)}; "$($s.Status)|$($s.SignerCertificate.Subject)"`)).stdout.trim();
    } catch (error) {
        return `its signature could not be read (${error instanceof Error ? error.message : String(error)})`;
    }
    const [status, subject = ''] = signature.split('|');
    if (status !== 'Valid' || !/^CN=Microsoft Corporation,/.test(subject)) return `its Authenticode signature is not a valid Microsoft one (${signature.slice(0, 160) || 'none'}), so it was not run`;
    let offered = '';
    try {
        offered = (await ps(ports.run, `(Get-Item -LiteralPath ${psQuote(exe)}).VersionInfo.ProductVersion`)).stdout.trim().split(/\s+/)[0] ?? '';
    } catch {
        offered = '';
    }
    try {
        await ps(ports.run, `Start-Process -FilePath ${psQuote(exe)} -ArgumentList '/install /quiet /norestart' -Verb RunAs -Wait`);
    } catch (error) {
        return `it could not be run (${error instanceof Error ? error.message : String(error)})`;
    }
    return offered ? `ran (it is version ${offered})` : null;
}

export async function ensureVcRuntimeAtLeast(min: string, ports: VcRuntimePorts): Promise<{ ok: true } | { ok: false; reason: string }> {
    const before = await dllVersion(ports.run, ports.systemRoot);
    if (before !== null && vcRuntimeAtLeast(before, min)) return { ok: true };
    ports.progress?.(`Updating the Microsoft Visual C++ runtime (${before ?? 'none'}) to ${min} or newer — Windows may ask for permission`);
    const tried: string[] = [];
    let wingetHere = true;
    for (const args of [['upgrade', '--id', PACKAGE, ...WINGET_QUIET], ['install', '--id', PACKAGE, '--force', ...WINGET_QUIET]]) {
        try {
            tried.push(`winget ${args[0]} exited ${(await ports.run('winget', args)).exitCode}`);
        } catch (error) {
            const words = error instanceof Error ? error.message : String(error);
            tried.push(`winget ${args[0]} could not run (${words})`);
            if (/ENOENT/.test(words)) { wingetHere = false; break; }
        }
        const now = await dllVersion(ports.run, ports.systemRoot);
        if (now !== null && vcRuntimeAtLeast(now, min)) return { ok: true };
    }
    if (!wingetHere || tried.length > 0) {
        const why = await viaMicrosoftDownload(ports);
        tried.push(`Microsoft's redistributable ${why ?? 'ran'}`);
        const now = await dllVersion(ports.run, ports.systemRoot);
        if (now !== null && vcRuntimeAtLeast(now, min)) return { ok: true };
    }
    const after = await dllVersion(ports.run, ports.systemRoot);
    return { ok: false, reason: `this machine's vcruntime140.dll is ${after ?? 'not readable'} (${tried.join('; ')})` };
}
