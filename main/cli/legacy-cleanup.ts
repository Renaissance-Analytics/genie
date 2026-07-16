import { app } from 'electron';
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

const CLEANUP_MARKER = '.tynn-cli-cleanup-v1.json';

function normalizePathEntry(value: string, platform: NodeJS.Platform): string {
    const normalized = value.trim().replace(/[\\/]+$/, '');
    return platform === 'win32'
        ? normalized.replace(/\//g, '\\').toLowerCase()
        : normalized;
}

/** Remove every exact occurrence of `entries` without changing other PATH entries. */
export function removePathEntries(
    current: string,
    entries: string[],
    delimiter: string,
    platform: NodeJS.Platform,
): { value: string; changed: boolean } {
    const targets = new Set(entries.map((entry) => normalizePathEntry(entry, platform)));
    const kept = current
        .split(delimiter)
        .filter((entry) => entry.trim() !== '')
        .filter((entry) => !targets.has(normalizePathEntry(entry, platform)));
    const value = kept.join(delimiter);
    return { value, changed: value !== current };
}

function isManagedBashPathLine(line: string): boolean {
    return /^\s*export\s+PATH=/.test(line) && /[\\/]\.genie[\\/]tynn-cli[\\/]/i.test(line);
}

/** Remove only Genie's managed tynn-cli PATH block/orphaned export. */
export function removeManagedBashrcLines(content: string): string {
    const newline = content.includes('\r\n') ? '\r\n' : '\n';
    const hadFinalNewline = content.endsWith('\n');
    const lines = content.split(/\r?\n/);
    if (hadFinalNewline) lines.pop();

    const next: string[] = [];
    for (let index = 0; index < lines.length; index++) {
        const line = lines[index];
        if (/^\s*#\s*tynn-cli\s*$/i.test(line) && isManagedBashPathLine(lines[index + 1] ?? '')) {
            index++;
            if (next[next.length - 1]?.trim() === '') next.pop();
            continue;
        }
        if (isManagedBashPathLine(line)) {
            continue;
        }
        next.push(line);
    }

    const output = next.join(newline);
    return output + (hadFinalNewline && output !== '' ? newline : '');
}

function runPowerShell(command: string, extraEnv?: Record<string, string>): Promise<string> {
    return new Promise((resolve, reject) => {
        const child = spawn(
            'powershell.exe',
            ['-NoProfile', '-NonInteractive', '-Command', command],
            { env: { ...process.env, ...extraEnv }, windowsHide: true },
        );
        let out = '';
        let err = '';
        child.stdout?.on('data', (data) => (out += data.toString()));
        child.stderr?.on('data', (data) => (err += data.toString()));
        child.on('error', reject);
        child.on('close', (code) => {
            if (code === 0) resolve(out);
            else reject(new Error(err.trim() || `powershell exit ${code}`));
        });
    });
}

function backupUserFiles(installDir: string, genieDir: string): string | null {
    const names = ['tynn.config', '.custom'].filter((name) =>
        fs.existsSync(path.join(installDir, name)),
    );
    if (names.length === 0) return null;

    const legacyRoot = path.join(genieDir, 'legacy');
    let backupDir = path.join(legacyRoot, 'tynn-cli');
    if (fs.existsSync(backupDir)) {
        backupDir = path.join(legacyRoot, `tynn-cli-${Date.now()}`);
    }
    fs.mkdirSync(backupDir, { recursive: true });
    for (const name of names) {
        fs.renameSync(path.join(installDir, name), path.join(backupDir, name));
    }
    return backupDir;
}

function rewriteBashrc(home: string): void {
    const bashrc = path.join(home, '.bashrc');
    if (!fs.existsSync(bashrc)) return;
    const current = fs.readFileSync(bashrc, 'utf8');
    const next = removeManagedBashrcLines(current);
    if (next !== current) fs.writeFileSync(bashrc, next, 'utf8');
}

async function removeWindowsUserPath(entries: string[]): Promise<void> {
    const raw = await runPowerShell(
        "[Environment]::GetEnvironmentVariable('Path','User')",
    );
    const current = raw.replace(/\r?\n$/, '');
    const { value, changed } = removePathEntries(current, entries, ';', 'win32');
    if (!changed) return;
    await runPowerShell(
        "[Environment]::SetEnvironmentVariable('Path', $env:GENIE_NEW_USER_PATH, 'User')",
        { GENIE_NEW_USER_PATH: value },
    );
}

/**
 * One-time removal for the system-wide toolkit installed by Genie <= beta.173.
 * Failures are logged by the caller and retried next launch; independent installs
 * outside ~/.genie are deliberately untouched.
 */
export async function cleanupLegacyTynnCliAt(
    home: string,
    options: {
        platform?: NodeJS.Platform;
        environment?: NodeJS.ProcessEnv;
        removeWindowsPath?: (entries: string[]) => Promise<void>;
    } = {},
): Promise<{
    cleaned: boolean;
    skipped: boolean;
    backupDir: string | null;
    error?: string;
}> {
    const platform = options.platform ?? process.platform;
    const environment = options.environment ?? process.env;
    const genieDir = path.join(home, '.genie');
    const marker = path.join(genieDir, CLEANUP_MARKER);
    if (fs.existsSync(marker)) {
        return { cleaned: false, skipped: true, backupDir: null };
    }

    const installDir = path.join(genieDir, 'tynn-cli');
    const pathEntries = [
        path.join(installDir, '.custom'),
        path.join(installDir, 'bin'),
        path.join(installDir, 'win-shims'),
    ];

    try {
        const backupDir = fs.existsSync(installDir)
            ? backupUserFiles(installDir, genieDir)
            : null;
        rewriteBashrc(home);

        const pathKey = Object.keys(environment).find((key) => key.toLowerCase() === 'path') ?? 'PATH';
        const delimiter = platform === 'win32' ? ';' : ':';
        const currentProcessPath = environment[pathKey] ?? '';
        environment[pathKey] = removePathEntries(
            currentProcessPath,
            pathEntries,
            delimiter,
            platform,
        ).value;

        if (platform === 'win32') {
            await (options.removeWindowsPath ?? removeWindowsUserPath)([
                path.join(installDir, 'win-shims'),
            ]);
        }

        fs.rmSync(installDir, { recursive: true, force: true });
        fs.mkdirSync(genieDir, { recursive: true });
        fs.writeFileSync(
            marker,
            JSON.stringify({ cleanedAt: new Date().toISOString(), backupDir }),
            'utf8',
        );
        return { cleaned: true, skipped: false, backupDir };
    } catch (error) {
        return {
            cleaned: false,
            skipped: false,
            backupDir: null,
            error: error instanceof Error ? error.message : String(error),
        };
    }
}

export function cleanupLegacyTynnCliInstall(): ReturnType<typeof cleanupLegacyTynnCliAt> {
    return cleanupLegacyTynnCliAt(app.getPath('home'));
}
