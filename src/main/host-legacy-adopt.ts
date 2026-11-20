import type { SecretName } from './keychain.js';
import type { HostVault, MigrationBook, MigrationOutcome } from './keychain-migration.js';
import type { LegacyIdentity } from './workstation-identity.js';

/**
 * GENIE-HOST ADOPTS WHAT AN OLDER GENIE SEALED (Tynn #959, client/host split step 2g-3b): `keychain.adoptLegacy`, phase
 * `adopt` (write, read back, `verified`, answer what the window may delete) and phase `removed` (`done`). RED: typed stubs.
 */
export type AdoptRead = { readonly kind: 'value'; readonly value: string } | { readonly kind: 'none' } | { readonly kind: 'unreadable'; readonly covers?: string };
export interface AdoptSecret { readonly name: string; readonly read: AdoptRead }
export type AdoptRequest =
    | { readonly phase: 'adopt'; readonly secrets: readonly AdoptSecret[]; readonly genie1Identity: LegacyIdentity | null }
    | { readonly phase: 'removed'; readonly names: readonly string[] };
export interface AdoptAnswer {
    readonly outcomes: readonly MigrationOutcome[];
    readonly remove: readonly SecretName[];
}
export type AdoptRefusal = { readonly ok: false; readonly reason: string };

export function movableSecret(_name: string): _name is SecretName {
    throw new Error('2g-3b: not built yet');
}

export function readAdoptRequest(_raw: unknown): AdoptRequest | AdoptRefusal {
    throw new Error('2g-3b: not built yet');
}

export interface HostLegacyAdoptPorts {
    readonly vault: HostVault;
    readonly book: MigrationBook;
    readonly log: (line: string) => void;
    readonly moved: (what: { readonly secretsMoved: boolean; readonly genie1Identity: LegacyIdentity | null }) => void;
    readonly env?: Readonly<Record<string, string | undefined>>;
}

export function hostLegacyAdopt(_ports: HostLegacyAdoptPorts): { adopt(raw: unknown): Promise<AdoptAnswer | AdoptRefusal> } {
    return { adopt: async () => { throw new Error('2g-3b: not built yet'); } };
}
