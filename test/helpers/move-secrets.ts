import { finishSecrets, removeOldCopies, verifySecrets, type HostVault, type MigrationBook, type MigrationOutcome, type MigrationSource } from '../../src/main/keychain-migration.js';

/**
 * THE WHOLE ONE-TIME MOVE IN ONE LAUNCH, as its two processes run it since Tynn #959 (2g-3b): genie-host's first half
 * (verifySecrets: write, read back, `verified`), the window's delete of exactly what it was told (removeOldCopies), and
 * genie-host's second half (finishSecrets: `done`). What each secret ends as is what the window's unsealer says
 * (legacy-unsealer.ts): the second half's word for what was deleted, the first half's for the rest.
 */
export async function moveAll(sources: readonly MigrationSource[], vault: HostVault, book: MigrationBook): Promise<MigrationOutcome[]> {
    const verified = await verifySecrets(sources, vault, book);
    const { removed, outcomes } = await removeOldCopies(sources, verified);
    const finished = removed.length > 0 ? await finishSecrets(removed, book) : [];
    return outcomes.map((o) => finished.find((f) => f.name === o.name) ?? o);
}
