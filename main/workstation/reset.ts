import fs from 'node:fs';
import path from 'node:path';

const RESET_MARKER = '.reset-workstation';
const PRESERVED_ENTRIES = new Set(['toolchain']);

export function isWorkstationResetPending(userDataDir: string): boolean {
    return fs.existsSync(path.join(userDataDir, RESET_MARKER));
}

export function requestWorkstationReset(userDataDir: string): void {
    fs.mkdirSync(userDataDir, { recursive: true });
    fs.writeFileSync(path.join(userDataDir, RESET_MARKER), new Date().toISOString(), {
        encoding: 'utf8',
        mode: 0o600,
    });
}

export function applyPendingWorkstationReset(
    userDataDir: string,
): { applied: boolean; preserved: string[] } {
    const marker = path.join(userDataDir, RESET_MARKER);
    if (!isWorkstationResetPending(userDataDir)) return { applied: false, preserved: [] };

    for (const entry of fs.readdirSync(userDataDir, { withFileTypes: true })) {
        if (entry.name === RESET_MARKER || PRESERVED_ENTRIES.has(entry.name)) continue;
        fs.rmSync(path.join(userDataDir, entry.name), { recursive: true, force: true });
    }
    fs.rmSync(marker, { force: true });
    return { applied: true, preserved: [...PRESERVED_ENTRIES] };
}
