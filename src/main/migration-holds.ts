import type { HostVault, MigrationBook, MigrationSource } from './keychain-migration.js';

export interface MigrationPorts {
    readonly sources: readonly MigrationSource[];
    readonly vault: HostVault;
    readonly book: MigrationBook;
}

// RED: the shape only.
export function holdMigration(ports: MigrationPorts, _env: Readonly<Record<string, string | undefined>> = process.env): MigrationPorts {
    return ports;
}
