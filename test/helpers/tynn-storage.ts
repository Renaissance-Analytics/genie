import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach } from 'vitest';

const directories: string[] = [];
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });
export const PAIRING_TOKEN = `gpk_01ARZ3NDEKTSV4RRFFQ69G5FAV.${'1'.repeat(64)}`;
export const PAIRING_SCOPES = ['genie:discovery', 'genie:projects', 'genie:workstations', 'genie:agents', 'genie:agent-tokens', 'genie:issue-watch', 'genie:issues', 'genie:inbox'];

/** In-memory fake cipher boundary, never a production encryption implementation. */
export function fakeTynnStorage() {
    const dir = mkdtempSync(join(tmpdir(), 'genie-tynn-account-'));
    directories.push(dir);
    return {
        file: join(dir, 'tynn.json'),
        cipher: { isAvailable: () => true, encrypt: (text: string) => Buffer.from(`test-sealed:${text}`), decrypt: (bytes: Buffer) => bytes.toString().slice('test-sealed:'.length) },
    };
}
