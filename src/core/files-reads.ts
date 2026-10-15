/**
 * THE FILE PANEL'S READS, SETTLED (§4.3: "an error renders in the tab body in words, never a blank editor").
 *
 * The panel asks the host for a file and for the tree over IPC. Either can REJECT — the host throwing (a directory
 * that vanished mid-walk, a permission), the IPC channel failing — and a rejected promise that nobody catches leaves
 * the panel's state where it was: `null`, which renders as nothing. These turn every outcome into something the panel
 * can say: the file, or the reason it is not there.
 */

export type Settled<T> = { ok: true; value: T } | { ok: false; error: string };

/** The reason in words: an Error's message, or the thrown value itself — never an empty string. */
export function reasonOf(error: unknown): string {
    const text = error instanceof Error ? error.message : String(error);
    return text.trim() === '' ? 'the read failed and gave no reason' : text;
}

/**
 * An open that cannot be blank: what the host answered, or — when the ask itself failed — an `ok: false` naming the
 * path and the reason, which the panel renders as its tab error.
 */
export async function openOrError<T extends { ok: boolean }>(read: () => Promise<T>, path: string): Promise<T | { ok: false; path: string; error: string }> {
    try {
        return await read();
    } catch (error) {
        return { ok: false, path, error: `Genie could not read ${path}: ${reasonOf(error)}` };
    }
}

/** Any other read (the tree): its value, or the reason it failed. */
export async function settle<T>(read: () => Promise<T>): Promise<Settled<T>> {
    try {
        return { ok: true, value: await read() };
    } catch (error) {
        return { ok: false, error: reasonOf(error) };
    }
}
