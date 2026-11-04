import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import { win32 } from 'node:path';

/**
 * HOW A PROGRAM IS FOUND ON WINDOWS. By a whole path, from Genie's own PATH, whatever the working folder is. Windows' own search also looks in a working folder and in whatever PATH a spawn was handed, so a program is resolved here first. `.\tool` and other names
 * with a folder in them are the caller's own choice and are left alone. Elsewhere the OS's search is already this.
 *
 * The system's own programs come from the system folder, whatever PATH says. A name not found on PATH becomes a whole path that does not exist, so it fails as not found rather than falling back to a search.
 *
 * Only .exe and .com: what can start with no shell, as Node's own search does. A shim is a shell's to run, and that is the caller's to say.
 */
export const PROGRAM_LOOKUP_VARIABLE = 'NoDefaultCurrentDirectoryInExePath';

export interface ProcessPorts {
    readonly platform: NodeJS.Platform;
    readonly env: NodeJS.ProcessEnv;
    readonly home: () => string;
    readonly chdir: (to: string) => void;
}

/** First thing in every process. The variable passes to what it starts. The folder is its own, never one it was started in. Neither is a reason not to start. */
export function hardenProcess(ports: ProcessPorts = { platform: process.platform, env: process.env, home: homedir, chdir: (to) => process.chdir(to) }): void {
    if (ports.platform !== 'win32') return;
    ports.env[PROGRAM_LOOKUP_VARIABLE] = '1';
    try { ports.chdir(ports.home()); } catch { /* It stays where it is: the variable and the whole paths still hold. */ }
}

export interface LookupPorts {
    readonly platform: NodeJS.Platform;
    readonly env: NodeJS.ProcessEnv;
    readonly isFile?: (path: string) => boolean;
}

const WHOLE = /^[A-Za-z]:[\\/]|^\\\\/;
const realIsFile = (path: string): boolean => { try { return statSync(path).isFile(); } catch { return false; } };

function systemRoot(env: NodeJS.ProcessEnv): string {
    const root = env['SystemRoot'] ?? env['SYSTEMROOT'] ?? '';
    return WHOLE.test(root) ? root : 'C:\\Windows';
}

const SYSTEM: Readonly<Record<string, readonly string[]>> = {
    cmd: ['System32', 'cmd.exe'],
    powershell: ['System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'],
    reg: ['System32', 'reg.exe'],
    taskkill: ['System32', 'taskkill.exe'],
    netsh: ['System32', 'netsh.exe'],
    where: ['System32', 'where.exe'],
    schtasks: ['System32', 'schtasks.exe'],
    icacls: ['System32', 'icacls.exe'],
    certutil: ['System32', 'certutil.exe'],
    whoami: ['System32', 'whoami.exe'],
};

/** The first of these file names in an absolute PATH entry, or `null`. A relative entry and the working folder are never looked in. */
function onPath(files: readonly string[], ports: LookupPorts): string | null {
    const isFile = ports.isFile ?? realIsFile;
    for (const raw of (ports.env['PATH'] ?? ports.env['Path'] ?? '').split(';')) {
        const entry = raw.trim().replace(/^"(.*)"$/, '$1');
        if (!WHOLE.test(entry)) continue;
        for (const file of files) {
            const whole = win32.join(entry, file);
            if (isFile(whole)) return whole;
        }
    }
    return null;
}

/** The whole path of what this name would start with no shell, or `null` when nothing would. Windows only; elsewhere the name, as the OS's own search is already this. */
export function findProgram(name: string, ports: LookupPorts = { platform: process.platform, env: process.env }): string | null {
    if (ports.platform !== 'win32') return name;
    if (/[\\/]/.test(name) || WHOLE.test(name)) return name;
    const stem = name.replace(/\.(exe|com)$/i, '');
    const system = SYSTEM[stem.toLowerCase()];
    if (system) return win32.join(systemRoot(ports.env), ...system);
    return onPath(/\.(exe|com)$/i.test(name) ? [name] : [`${name}.com`, `${name}.exe`], ports);
}

/** The whole path of a batch file by this name, in an absolute PATH entry only, or `null`. Windows only. Not for a shell's line: the engine starts it as it starts a program. */
export function findBatchFile(name: string, ports: LookupPorts = { platform: process.platform, env: process.env }): string | null {
    if (ports.platform !== 'win32' || /[\\/]/.test(name)) return null;
    return onPath(/\.(cmd|bat)$/i.test(name) ? [name] : [`${name}.cmd`, `${name}.bat`], ports);
}

/**
 * Windows always runs a batch file through cmd, so an argument can be a command to it however it's quoted. The argument
 * that can't go to one, or `null`. fancy-pty 0.5.0 refuses the same set.
 */
export function unsafeBatchArgument(program: string, args: readonly string[]): string | null {
    if (!/\.(cmd|bat)$/i.test(program)) return null;
    return args.find((arg) => /[&|<>^%"!\r\n]/.test(arg)) ?? null;
}

export function resolveProgram(name: string, ports: LookupPorts = { platform: process.platform, env: process.env }): string {
    return findProgram(name, ports) ?? win32.join(systemRoot(ports.env), 'System32', `${name.replace(/\.(exe|com)$/i, '')}.exe`);
}

/** Why a name can't be started, in words. Names no path that isn't there. */
export function notFoundWords(name: string, _ports: LookupPorts = { platform: process.platform, env: process.env }): string {
    return `"${name}" was not found on this machine's PATH, so nothing was started.`;
}
