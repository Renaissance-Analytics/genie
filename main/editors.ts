import fs from 'fs';
import path from 'path';
import os from 'os';

/**
 * Detect installed editors by checking well-known install paths on each OS.
 * Used by Settings to populate the editor dropdown without forcing the user
 * to know where their binaries live.
 */

export interface EditorDetection {
    id: 'cursor' | 'vscode' | 'code-insiders';
    label: string;
    path: string;
}

export function detectEditors(): EditorDetection[] {
    const found: EditorDetection[] = [];
    const candidates = candidatePaths();

    for (const c of candidates) {
        for (const p of c.paths) {
            if (fs.existsSync(p)) {
                found.push({ id: c.id, label: c.label, path: p });
                break;
            }
        }
    }
    return found;
}

function candidatePaths(): Array<{
    id: EditorDetection['id'];
    label: string;
    paths: string[];
}> {
    const home = os.homedir();
    const platform = process.platform;

    if (platform === 'win32') {
        const programs = process.env['ProgramFiles'] ?? 'C:\\Program Files';
        const programsX86 =
            process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';
        const local = process.env['LOCALAPPDATA'] ?? path.join(home, 'AppData', 'Local');
        return [
            {
                id: 'cursor',
                label: 'Cursor',
                paths: [
                    path.join(local, 'Programs', 'cursor', 'Cursor.exe'),
                    path.join(programs, 'Cursor', 'Cursor.exe'),
                ],
            },
            {
                id: 'vscode',
                label: 'VS Code',
                paths: [
                    path.join(local, 'Programs', 'Microsoft VS Code', 'Code.exe'),
                    path.join(programs, 'Microsoft VS Code', 'Code.exe'),
                    path.join(programsX86, 'Microsoft VS Code', 'Code.exe'),
                ],
            },
            {
                id: 'code-insiders',
                label: 'VS Code Insiders',
                paths: [
                    path.join(local, 'Programs', 'Microsoft VS Code Insiders', 'Code - Insiders.exe'),
                    path.join(programs, 'Microsoft VS Code Insiders', 'Code - Insiders.exe'),
                ],
            },
        ];
    }

    if (platform === 'darwin') {
        return [
            {
                id: 'cursor',
                label: 'Cursor',
                paths: [
                    '/Applications/Cursor.app/Contents/MacOS/Cursor',
                    path.join(home, 'Applications', 'Cursor.app', 'Contents', 'MacOS', 'Cursor'),
                ],
            },
            {
                id: 'vscode',
                label: 'VS Code',
                paths: [
                    '/Applications/Visual Studio Code.app/Contents/MacOS/Electron',
                    path.join(home, 'Applications', 'Visual Studio Code.app', 'Contents', 'MacOS', 'Electron'),
                ],
            },
            {
                id: 'code-insiders',
                label: 'VS Code Insiders',
                paths: [
                    '/Applications/Visual Studio Code - Insiders.app/Contents/MacOS/Electron',
                ],
            },
        ];
    }

    // Linux
    return [
        {
            id: 'cursor',
            label: 'Cursor',
            paths: ['/usr/bin/cursor', '/usr/local/bin/cursor', path.join(home, '.local/bin/cursor')],
        },
        {
            id: 'vscode',
            label: 'VS Code',
            paths: ['/usr/bin/code', '/usr/local/bin/code', '/snap/bin/code'],
        },
        {
            id: 'code-insiders',
            label: 'VS Code Insiders',
            paths: ['/usr/bin/code-insiders', '/usr/local/bin/code-insiders'],
        },
    ];
}
