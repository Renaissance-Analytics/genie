import { writeFileSync } from 'node:fs';
import type { HostVault, MigrationBook, MigrationSource } from './keychain-migration.js';

/**
 * A TEST BUILD THAT STOPS AT EACH STEP OF THE MOVE (plan §13, S4; scripts/upgrade-crash-acceptance.mjs). Built in only by `GENIE_TEST_HOLDS=1 npm run build:main`, which nothing that ships does
 * (test/migration-holds.test.ts holds that): in any other build this hands the ports back as they came, whatever the environment says.
 *
 * It wraps the engine's ports and leaves the engine alone, so what is killed is the move as it ships. A hold is a port that never returns, the same crash test/keychain-migration.test.ts uses, with
 * a file written first so a script knows when to kill Genie. GENIE_TEST_MIGRATION_HOLD is `<step>:<secret>`; each step is named for what has already happened when it stops:
 *   before-write     nothing has         after-write  written, not read back     after-read-back  read back, not booked
 *   after-book       booked as verified, the old copy still there                after-delete     the old copy gone, not booked as done
 * The move spans two processes since Tynn #959 (2g-3b): the window's delete holds at `after-book` (holdSources, legacy-unsealer.ts);
 * genie-host's keychain and book hold at the other four (holdHostPorts, host-legacy-adopt.ts).
 */
declare const __GENIE_TEST_HOLDS__: boolean | undefined;

const STEPS: ReadonlySet<string> = new Set(['before-write', 'after-write', 'after-read-back', 'after-book', 'after-delete']);

/** The hold asked for in this test build, or null: every shipping build, and a test build with nothing asked. */
function holdPoint(env: Readonly<Record<string, string | undefined>>): ((here: string, secret: string) => Promise<void>) | null {
    if (typeof __GENIE_TEST_HOLDS__ === 'undefined' || !__GENIE_TEST_HOLDS__) return null;
    const asked = env.GENIE_TEST_MIGRATION_HOLD ?? '';
    const marker = env.GENIE_TEST_MIGRATION_HOLD_FILE;
    const colon = asked.indexOf(':');
    const step = asked.slice(0, colon);
    const name = asked.slice(colon + 1);
    if (!marker || colon < 0 || !STEPS.has(step)) return null;
    return async (here, secret) => {
        if (here !== step || secret !== name) return;
        writeFileSync(marker, asked);
        await new Promise<never>(() => {});
    };
}

/** The window's half: its old copies, held just before one is deleted. */
export function holdSources(sources: readonly MigrationSource[], env: Readonly<Record<string, string | undefined>> = process.env): readonly MigrationSource[] {
    const at = holdPoint(env);
    if (!at) return sources;
    return sources.map((source) => ({
        ...source,
        old: {
            read: () => source.old.read(),
            remove: async () => { await at('after-book', source.name); return source.old.remove(); },
        },
    }));
}

export interface HostMigrationPorts {
    readonly vault: HostVault;
    readonly book: MigrationBook;
}

/** genie-host's half: its keychain and its book, held before each write and read-back. */
export function holdHostPorts(ports: HostMigrationPorts, env: Readonly<Record<string, string | undefined>> = process.env): HostMigrationPorts {
    const at = holdPoint(env);
    if (!at) return ports;
    // `after-write` is the read-back, so only a compare past a write of that secret holds there: with no row the move compares
    // once BEFORE it writes (the security review of #2120), and that compare is not past anything.
    const written = new Set<string>();
    return {
        vault: {
            store: async (secret, value) => { await at('before-write', secret); const r = await ports.vault.store(secret, value); written.add(secret); return r; },
            compare: async (secret, value) => { if (written.has(secret)) await at('after-write', secret); return ports.vault.compare(secret, value); },
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
