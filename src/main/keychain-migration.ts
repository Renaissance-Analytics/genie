import type { Keychain, KeychainResult, SecretName } from './keychain.js';

export type OldRead = { readonly kind: 'value'; readonly value: string } | { readonly kind: 'none' } | { readonly kind: 'unreadable' };
export interface OldCopy { read(): Promise<OldRead>; remove(): Promise<void> }
export interface MigrationSource { readonly name: SecretName; readonly old: OldCopy }
export type Comparison = 'same' | 'different' | 'missing' | 'unavailable';
export interface HostVault { store(name: SecretName, value: string): Promise<KeychainResult>; compare(name: SecretName, value: string): Promise<Comparison> }
export type MigrationState = 'verified' | 'done';
export interface MigrationBook { read(): Promise<Record<string, MigrationState>>; write(name: SecretName, state: MigrationState): Promise<void> }
export type MigrationStatus = 'moved' | 'nothing' | 'already' | 'keychain-unavailable' | 'read-back-differs' | 'old-copy-unreadable' | 'confirmed-entry-missing' | 'old-copy-left' | 'book-failed';
export interface MigrationOutcome { readonly name: SecretName; readonly status: MigrationStatus }

/** RED STUB (the first commit of cut b): the obvious wrong migration, so the tests fail on behaviour. Replaced next. */
export async function migrateSecrets(sources: readonly MigrationSource[], vault: HostVault, _book: MigrationBook): Promise<MigrationOutcome[]> {
    const out: MigrationOutcome[] = [];
    for (const { name, old } of sources) {
        const read = await old.read();
        if (read.kind === 'value') { await vault.store(name, read.value); await old.remove(); }
        out.push({ name, status: 'moved' });
    }
    return out;
}
export function hostVault(keychain: Keychain): HostVault {
    return { store: (name, value) => keychain.set(name, value), compare: async () => 'same' };
}
export function fileMigrationBook(_file: string): MigrationBook {
    return { read: async () => ({}), write: async () => {} };
}
