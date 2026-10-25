import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { applyShellBlock, hasShellBlock, removeShellBlock, shellFilesToEdit, windowsPathHas, windowsPathWith, windowsPathWithout } from '../core/machine-path.js';
import type { CommandRunner } from './toolchain-prober.js';

/**
 * THE MACHINE'S OWN PATH, ONCE, WITH CONSENT (plan `.ai/plans/genie-2-toolchain-rest.md`, row TC3b; the pure half is
 * core/machine-path.ts). Windows: the user PATH in HKCU\Environment, read RAW (unexpanded) and written back as an
 * expandable string, the change broadcast so new terminals see it — never `setx`, which truncates at 1024 characters.
 * macOS/Linux: one marked block in the shell's startup files. Each change is MEASURED by reading it back.
 */

export interface MachinePathFs {
    exists(path: string): boolean;
    readText(path: string): string | null;
    writeText(path: string, text: string): void;
}

export interface MachinePathPorts {
    readonly platform: 'win32' | 'linux' | 'darwin';
    readonly home: string;
    /** The fixed `current` entries (core/toolchain-defaults.ts `defaultPathEntries`). */
    readonly entries: readonly string[];
    readonly fs: MachinePathFs;
    readonly run: CommandRunner;
}

export type MachinePathOutcome =
    | { readonly kind: 'applied'; readonly where: readonly string[] }
    | { readonly kind: 'removed'; readonly where: readonly string[] }
    | { readonly kind: 'refused'; readonly reason: string }
    | { readonly kind: 'not-applied'; readonly reason: string };

const WHERE_WINDOWS = 'the user PATH (HKCU\\Environment)';

/** A PowerShell single-quoted literal: `'` doubled. */
const psQuote = (s: string) => `'${s.replace(/'/g, "''")}'`;

const READ = "(Get-Item -LiteralPath 'HKCU:\\Environment').GetValue('Path', '', 'DoNotExpandEnvironmentNames')";
// WM_SETTINGCHANGE "Environment" to every top-level window, so Explorer (and terminals it starts) pick up the new PATH.
const BROADCAST = [
    "$sig='[DllImport(\"user32.dll\",SetLastError=true,CharSet=CharSet.Auto)] public static extern IntPtr SendMessageTimeout(IntPtr h,uint m,UIntPtr w,string l,uint f,uint t,out UIntPtr r);'",
    '$t=Add-Type -MemberDefinition $sig -Name W -Namespace GenieEnv -PassThru',
    "$r=[UIntPtr]::Zero; [void]$t::SendMessageTimeout([IntPtr]0xffff,0x1A,[UIntPtr]::Zero,'Environment',2,5000,[ref]$r)",
].join('; ');

async function readWindowsPath(ports: MachinePathPorts): Promise<string | null> {
    try {
        const r = await ports.run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', READ]);
        return r.exitCode === 0 ? r.stdout.replace(/\r?\n$/, '') : null;
    } catch {
        return null;
    }
}

async function writeWindowsPath(value: string, ports: MachinePathPorts): Promise<string | null> {
    try {
        const r = await ports.run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Set-ItemProperty -Path 'HKCU:\\Environment' -Name 'Path' -Value ${psQuote(value)} -Type ExpandString; ${BROADCAST}`]);
        return r.exitCode === 0 ? null : `PowerShell exited ${r.exitCode}${r.stdout.trim() ? `: ${r.stdout.trim().slice(0, 200)}` : ''}`;
    } catch (error) {
        return error instanceof Error ? error.message : String(error);
    }
}

const shellFiles = (ports: MachinePathPorts): string[] =>
    shellFilesToEdit(['.bash_profile', '.bashrc', '.zprofile', '.zshrc'].filter((f) => ports.fs.exists(join(ports.home, f)))).map((f) => join(ports.home, f));

/** Whether the entries are on the machine's PATH now, and where. */
export async function machinePathStatus(ports: MachinePathPorts): Promise<{ applied: boolean; where: string[] }> {
    if (ports.platform === 'win32') {
        const raw = await readWindowsPath(ports);
        return raw !== null && windowsPathHas(raw, ports.entries) ? { applied: true, where: [WHERE_WINDOWS] } : { applied: false, where: [] };
    }
    const where = shellFiles(ports).filter((f) => hasShellBlock(ports.fs.readText(f)));
    return { applied: where.length > 0, where };
}

/** APPLY — only on the person's click. Idempotent; each write read back. */
export async function applyMachinePath(consent: boolean, ports: MachinePathPorts): Promise<MachinePathOutcome> {
    if (consent !== true) return { kind: 'refused', reason: 'Genie changes your PATH only with your go-ahead; nothing was changed' };
    if (ports.platform === 'win32') {
        const raw = await readWindowsPath(ports);
        if (raw === null) return { kind: 'not-applied', reason: 'your user PATH could not be read, so it was not changed' };
        const next = windowsPathWith(raw, ports.entries);
        if (next !== raw) {
            const failed = await writeWindowsPath(next, ports);
            if (failed) return { kind: 'not-applied', reason: `your user PATH could not be written (${failed}); it was not changed` };
            const back = await readWindowsPath(ports);
            if (back !== next) return { kind: 'not-applied', reason: 'your user PATH was written, but it does not read back as Genie wrote it' };
        }
        return { kind: 'applied', where: [WHERE_WINDOWS] };
    }
    const files = shellFiles(ports);
    for (const f of files) {
        const before = ports.fs.readText(f);
        const next = applyShellBlock(before, ports.entries);
        if (next === before) continue;
        try {
            ports.fs.writeText(f, next);
        } catch (error) {
            return { kind: 'not-applied', reason: `${f} could not be written (${error instanceof Error ? error.message : String(error)})` };
        }
        if (ports.fs.readText(f) !== next) return { kind: 'not-applied', reason: `${f} was written, but it does not read back as Genie wrote it` };
    }
    return { kind: 'applied', where: files };
}

/** UNDO — removes only what Genie added; the PATH and files are exactly as they were. */
export async function removeMachinePath(ports: MachinePathPorts): Promise<MachinePathOutcome> {
    if (ports.platform === 'win32') {
        const raw = await readWindowsPath(ports);
        if (raw === null) return { kind: 'not-applied', reason: 'your user PATH could not be read, so it was not changed' };
        const next = windowsPathWithout(raw, ports.entries);
        if (next !== raw) {
            const failed = await writeWindowsPath(next, ports);
            if (failed) return { kind: 'not-applied', reason: `your user PATH could not be written (${failed})` };
            if ((await readWindowsPath(ports)) !== next) return { kind: 'not-applied', reason: 'your user PATH was written, but it does not read back as Genie wrote it' };
        }
        return { kind: 'removed', where: [WHERE_WINDOWS] };
    }
    const where: string[] = [];
    for (const f of shellFiles(ports)) {
        const before = ports.fs.readText(f);
        if (before === null || !hasShellBlock(before)) continue;
        ports.fs.writeText(f, removeShellBlock(before));
        where.push(f);
    }
    return { kind: 'removed', where };
}

/** The real filesystem (UTF-8 text). */
export function nodeMachinePathFs(): MachinePathFs {
    return {
        exists: (p) => { try { return existsSync(p); } catch { return false; } },
        readText: (p) => { try { return readFileSync(p, 'utf8'); } catch { return null; } },
        writeText: (p, t) => writeFileSync(p, t, 'utf8'),
    };
}
