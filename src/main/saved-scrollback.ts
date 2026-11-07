import { rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * WHAT AN OLDER GENIE SAVED OF A TERMINAL'S SCREEN, DELETED (the owner's decision 2, 2026-11-02: "stop saving it"; plan §13).
 * A terminal's buffer is where people paste tokens. It was written in the clear to `terminal-snapshots.json` at every full
 * quit; the in-window engine's `terminal-snapshots/` store could fall back to plaintext gzip. Nothing writes or reads either
 * now, so each boot removes them. A failure is said and tried again at the next boot.
 */
export async function removeSavedScrollback(home: string, log: (line: string) => void): Promise<void> {
    for (const name of ['terminal-snapshots.json', 'terminal-snapshots']) {
        const path = join(home, name);
        const there = await stat(path).then(() => true, () => false);
        if (!there) continue;
        try {
            await rm(path, { recursive: true, force: true });
            log(`removed saved scrollback: ${name}`);
        } catch (error) {
            log(`could not remove saved scrollback ${name}: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
}
