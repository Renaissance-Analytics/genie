import { renameOverSync } from '../core/atomic-rename.js';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Keychain, KeychainRead, KeychainResult, SecretName } from './keychain.js';

/**
 * WHERE THIS MACHINE HAS PAIRED (P3.4 cut e, audit M-e). Each token an owner-level key to another machine, in the keychain as `device/<its socket url>`. A keychain cannot
 * list its entries, so a file says which urls have one. It holds addresses, never a token: the known-hosts list in a window already showed them.
 */
export interface DeviceTokens {
    tokenFor(url: string): Promise<KeychainRead>;
    /** Written and read back. A token that does not read back the same is not remembered, and the host is not listed as paired. */
    remember(url: string, token: string): Promise<KeychainResult>;
    /** A locked keychain keeps the row: the secret is still there, and a list that said otherwise would be wrong. */
    forget(url: string): Promise<KeychainResult>;
    hosts(): string[];
}

const nameOf = (url: string): SecretName => `device/${url}`;

export function deviceTokenStore(file: string, keychain: Pick<Keychain, 'get' | 'set' | 'delete'>): DeviceTokens {
    const read = (): string[] => {
        try {
            const parsed = JSON.parse(readFileSync(file, 'utf8')) as { hosts?: unknown };
            return Array.isArray(parsed.hosts) ? parsed.hosts.filter((h): h is string => typeof h === 'string') : [];
        } catch {
            return [];
        }
    };
    const write = (hosts: readonly string[]): void => {
        mkdirSync(dirname(file), { recursive: true });
        const fresh = `${file}.tmp`;
        writeFileSync(fresh, JSON.stringify({ hosts }, null, 2), { mode: 0o600 });
        renameOverSync(fresh, file);
    };
    return {
        tokenFor: (url) => keychain.get(nameOf(url)),
        remember: async (url, token) => {
            const written = await keychain.set(nameOf(url), token);
            if (!written.ok) return written;
            const back = await keychain.get(nameOf(url));
            if (back.kind !== 'value' || back.value !== token) return { ok: false, reason: back.kind === 'unavailable' ? back.reason : 'the keychain did not read back what was written' };
            const hosts = read();
            if (!hosts.includes(url)) write([...hosts, url]);
            return { ok: true };
        },
        forget: async (url) => {
            const removed = await keychain.delete(nameOf(url));
            if (!removed.ok) return removed;
            write(read().filter((h) => h !== url));
            return { ok: true };
        },
        hosts: read,
    };
}
