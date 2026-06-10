import { spawn, ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { simpleGit } from 'simple-git';
import { getWorkspace, touchWorkspace, getAllSettings } from '../db';
import { rebuildMenu } from '../tray';
import { detectFolder } from './detect';

/**
 * Open a registered workspace:
 *   1. (`.agi` only) `git submodule update --init --recursive` if repos/
 *      is empty but .gitmodules has entries.
 *   2. Launch the configured editor at the path.
 *   3. Open a terminal at the path with the workspace's env file sourced.
 *   4. Touch the row's last_opened_at.
 */
// Tracks in-flight openWorkspace calls so rapid double-clicks (or HMR
// re-fires) can't stack multiple terminals + editors for the same row.
// Entry is removed when the call resolves; concurrent calls for OTHER
// workspaces are unaffected.
const opening = new Set<string>();

export async function openWorkspace(id: string): Promise<void> {
    if (opening.has(id)) return;
    opening.add(id);
    try {
        await openWorkspaceInner(id);
    } finally {
        opening.delete(id);
    }
}

async function openWorkspaceInner(id: string): Promise<void> {
    const row = getWorkspace(id);
    if (!row) throw new Error(`Workspace not found: ${id}`);
    if (!fs.existsSync(row.path)) {
        throw new Error(`Workspace folder missing: ${row.path}`);
    }

    if (row.shape === 'agi') {
        const det = detectFolder(row.path);
        if (det.has_gitmodules && det.repos.length === 0) {
            const git = simpleGit(row.path);
            await git.submoduleUpdate(['--init', '--recursive']);
        }
    }

    const settings = getAllSettings();
    const editorCmd =
        row.editor_cmd ||
        settings.default_editor_cmd ||
        defaultEditorBinary(row.editor ?? settings.default_editor);
    const envFile = row.env_file || settings.default_env_file || '.env';
    const envFilePath = path.join(row.path, envFile);

    // Editor
    if (editorCmd) {
        try {
            const child = spawn(editorCmd, [row.path], {
                detached: true,
                stdio: 'ignore',
                shell: process.platform === 'win32',
            });
            child.unref();
        } catch (e) {
            console.error('Failed to launch editor', editorCmd, e);
        }
    }

    // Terminal
    spawnTerminal(row.path, envFilePath);

    touchWorkspace(id);
    rebuildMenu();
}

function defaultEditorBinary(editor: string | null | undefined): string {
    switch ((editor ?? '').toLowerCase()) {
        case 'vscode':
            return process.platform === 'win32' ? 'code.cmd' : 'code';
        case 'code-insiders':
            return process.platform === 'win32'
                ? 'code-insiders.cmd'
                : 'code-insiders';
        case 'cursor':
        default:
            return process.platform === 'win32' ? 'cursor.cmd' : 'cursor';
    }
}

function spawnTerminal(workspacePath: string, envFilePath: string): void {
    const hasEnvFile = fs.existsSync(envFilePath);

    if (process.platform === 'win32') {
        // Inlining a multi-line PowerShell command through `wt new-tab` and
        // `shell: true` is a quoting nightmare — wt's argv parser, cmd.exe,
        // and PowerShell each get a turn at the string and the quotes don't
        // survive. Write the source-env-then-cd script to a temp .ps1 and
        // launch PowerShell with `-File`. No shell layer needed, no escaping.
        const script = [
            hasEnvFile
                ? `Get-Content -LiteralPath ${psStringLiteral(envFilePath)} | ForEach-Object { if ($_ -match '^\\s*([^#=\\s][^=]*)=(.*)$') { [Environment]::SetEnvironmentVariable($Matches[1].Trim(), $Matches[2].Trim()) } }`
                : null,
            `Set-Location -LiteralPath ${psStringLiteral(workspacePath)}`,
        ].filter(Boolean).join('\n');

        const tmpDir = path.join(os.tmpdir(), 'genie-shell');
        try { fs.mkdirSync(tmpDir, { recursive: true }); } catch { /* fine */ }
        const scriptPath = path.join(tmpDir, `open-${Date.now()}-${process.pid}.ps1`);
        fs.writeFileSync(scriptPath, script, 'utf8');

        const wtArgs = [
            'new-tab',
            '-d', workspacePath,
            'powershell.exe',
            '-NoExit',
            '-ExecutionPolicy', 'Bypass',
            '-File', scriptPath,
        ];

        try {
            spawn('wt.exe', wtArgs, {
                detached: true,
                stdio: 'ignore',
                shell: false,
            }).unref();
        } catch {
            // Windows Terminal not installed (older Win10). Open plain
            // PowerShell in a new console at the workspace path.
            try {
                spawn('powershell.exe', [
                    '-NoExit', '-ExecutionPolicy', 'Bypass', '-File', scriptPath,
                ], {
                    detached: true,
                    stdio: 'ignore',
                    shell: false,
                }).unref();
            } catch {
                // Last resort: cmd.exe at the path.
                spawn('cmd.exe', ['/c', 'start', '', 'cmd', '/K', `cd /d "${workspacePath}"`], {
                    detached: true,
                    stdio: 'ignore',
                    shell: false,
                }).unref();
            }
        }
        return;
    }

    if (process.platform === 'darwin') {
        const script = hasEnvFile
            ? `tell application "Terminal" to do script "cd '${workspacePath.replace(/'/g, "'\\''")}' && set -a && source '${envFilePath.replace(/'/g, "'\\''")}' && set +a"`
            : `tell application "Terminal" to do script "cd '${workspacePath.replace(/'/g, "'\\''")}'"`;
        spawn('osascript', ['-e', script], {
            detached: true,
            stdio: 'ignore',
        }).unref();
        return;
    }

    // Linux — try gnome-terminal, fall back to xterm.
    // (PowerShell single-quoted literal helper lives just below; not used on Linux.)
    const terminals = ['gnome-terminal', 'konsole', 'xfce4-terminal', 'xterm'];
    const args = hasEnvFile
        ? ['--', 'bash', '-c', `cd "${workspacePath}" && set -a && source "${envFilePath}" && set +a && exec bash`]
        : ['--working-directory', workspacePath];
    for (const term of terminals) {
        try {
            spawn(term, args, {
                detached: true,
                stdio: 'ignore',
            }).unref();
            return;
        } catch {
            /* try next */
        }
    }
}

/**
 * Wrap a path/value as a PowerShell single-quoted string literal. Single
 * quotes in PowerShell strings are escaped by doubling them; nothing else
 * is interpreted. Safe for paths with spaces, $, backticks, parens, etc.
 */
function psStringLiteral(value: string): string {
    return `'${value.replace(/'/g, "''")}'`;
}
