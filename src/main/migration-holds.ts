import { writeFileSync } from 'node:fs';
import type { HostVault, MigrationBook, MigrationSource } from './keychain-migration.js';

/**
 * A TEST BUILD THAT STOPS AT EACH STEP OF THE MOVE (plan §13, S4; scripts/upgrade-crash-acceptance.mjs). Built in only by `GENIE_TEST_HOLDS=1 npm run build:main`, which nothing that ships does
 * (test/migration-holds.test.ts holds that): in any other build this hands the ports back as they came, whatever the environment says.
 *
 * It wraps the engine's ports and leaves the engine alone, so what is killed is the move as it ships. A hold is a port that never returns, the same crash test/keychain-migration.test.ts uses, with
 * a file written first so a script knows when to kill the window. GENIE_TEST_MIGRATION_HOLD is `<step>:<secret>`; each step is named for what has already happened when it stops:
 *   before-write     nothing has         after-write  written, not read back     after-read-back  read back, not booked
 *   after-book       booked as verified, the old copy still there                after-delete     the old copy gone, not booked as done
 */
declare const __GENIE_TEST_HOLDS__: boolean | undefined;

export interface MigrationPorts {
    readonly sources: readonly MigrationSource[];
    readonly vault: HostVault;
    readonly book: MigrationBook;
}

const STEPS: ReadonlySet<string> = new Set(['before-write', 'after-write', 'after-read-back', 'after-book', 'after-delete']);

export function holdMigration(ports: MigrationPorts, env: Readonly<Record<string, string | undefined>> = process.env): MigrationPorts {
    if (typeof __GENIE_TEST_HOLDS__ === 'undefined' || !__GENIE_TEST_HOLDS__) return ports;
    const asked = env.GENIE_TEST_MIGRATION_HOLD ?? '';
    const marker = env.GENIE_TEST_MIGRATION_HOLD_FILE;
    const colon = asked.indexOf(':');
    const step = asked.slice(0, colon);
    const name = asked.slice(colon + 1);
    if (!marker || colon < 0 || !STEPS.has(step)) return ports;
    const at = async (here: string, secret: string): Promise<void> => {
        if (here !== step || secret !== name) return;
        writeFileSync(marker, asked);
        await new Promise<never>(() => {});
    };
    return {
        sources: ports.sources.map((source) => ({
            ...source,
            old: {
                read: () => source.old.read(),
                remove: async () => { await at('after-book', source.name); return source.old.remove(); },
            },
        })),
        vault: {
            store: async (secret, value) => { await at('before-write', secret); return ports.vault.store(secret, value); },
            compare: async (secret, value) => { await at('after-write', secret); return ports.vault.compare(secret, value); },
        },
        book: {
            ...ports.book,
            read: () => ports.book.read(),
            write: async (secret, state) => {
                await at(state === 'verified' ? 'after-read-back' : 'after-delete', secret);
                return ports.book.write(secret, state);
            },
        },
    };
}

/** The ports, as migrateSecrets takes them. */
export function portsOf(ports: MigrationPorts): [readonly MigrationSource[], HostVault, MigrationBook] {
    return [ports.sources, ports.vault, ports.book];
}
