import type { HostSummary } from '../core/host-summary.js';
import type { MigrationSource } from './keychain-migration.js';
import type { OwnCallAnswer } from './own-protocol-client.js';
import type { LegacyIdentity } from './workstation-identity.js';

/**
 * THE WINDOW'S ONE-SHOT UNSEALER (Tynn #959, client/host split step 2g-3b). RED: typed stubs.
 */
export interface LegacyUnsealerPorts {
    readonly sources: () => Promise<readonly MigrationSource[]>;
    readonly genie1Identity: () => Promise<LegacyIdentity | null>;
    readonly call: (method: 'keychain.adoptLegacy', args: unknown[]) => Promise<OwnCallAnswer>;
    readonly log: (line: string) => void;
    readonly env?: Readonly<Record<string, string | undefined>>;
}

export interface LegacyUnsealer {
    run(): Promise<void>;
    summary(before: HostSummary, after: HostSummary): void;
}

export function legacyUnsealer(_ports: LegacyUnsealerPorts): LegacyUnsealer {
    return { run: async () => { throw new Error('2g-3b: not built yet'); }, summary: () => { throw new Error('2g-3b: not built yet'); } };
}
