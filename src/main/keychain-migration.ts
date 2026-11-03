import { readFile } from 'node:fs/promises';
import { MAX_SECRET_CHARS, type Keychain, type KeychainResult, type SecretName } from './keychain.js';
import { writeJsonAtomic } from './store.js';

/**
 * THE ONE-TIME MOVE INTO THE KEYCHAIN (the host split, P3.4 cut b; plan §13). The one place a bug loses a person's sign-ins.
 * `safeStorage` exists only in Electron, so the window decrypts each secret and hands it over; the HOST writes it and reads it
 * back; only a byte-for-byte match lets the window delete its copy. There is no path back (decision 5), and no fallback: no
 * keychain means nothing moves, and the old copy stays where it is (decision 3).
 *
 * THE ORDER IS THE SAFETY:
 *   read the old copy -> write -> read back -> book says `verified` -> delete the old copy -> book says `done`
 * A crash anywhere leaves a working copy, because nothing is deleted before `verified` is durably recorded.
 *
 * WHAT THE BOOK DECIDES, for the launch after a crash:
 *  - no entry: nobody is using the keychain's copy yet, so the OLD COPY IS THE TRUTH. It is written again, over anything
 *    found there (a stale entry from an earlier install is replaced, never believed), and read back again.
 *  - `verified`: the keychain's copy is the one in use and may have been renewed since, so the old copy is never written
 *    back. All that is left is the delete, and only while the keychain still holds an entry.
 *  - `done`: never run again. The old copy is not even read.
 *
 * Each secret answers for itself, in words with no value in them. Each kind of secret switches on with its reader, and no
 * sooner: the agents' keys in compose.ts, the rest with theirs.
 */

export type OldRead = { readonly kind: 'value'; readonly value: string } | { readonly kind: 'none' } | { readonly kind: 'unreadable' };
/** Where a secret is kept today: an encrypted field in the window's files. */
export interface OldCopy {
    read(): Promise<OldRead>;
    remove(): Promise<void>;
}
export interface MigrationSource {
    readonly name: SecretName;
    readonly old: OldCopy;
}
export type Comparison = 'same' | 'different' | 'missing' | 'unavailable';
/** The host's half, over the authenticated link. `compare` answers same-or-not: the secret does not come back across the link. */
export interface HostVault {
    store(name: SecretName, value: string): Promise<KeychainResult>;
    compare(name: SecretName, value: string): Promise<Comparison>;
}
export type MigrationState = 'verified' | 'done';
export interface MigrationBook {
    /** Rejects when it cannot be understood: an unreadable book is not an empty one. */
    read(): Promise<Record<string, MigrationState>>;
    write(name: SecretName, state: MigrationState): Promise<void>;
}
export type MigrationStatus =
    | 'moved'
    | 'nothing'
    | 'already'
    | 'keychain-unavailable'
    | 'read-back-differs'
    | 'too-large'
    | 'old-copy-unreadable'
    | 'confirmed-entry-missing'
    | 'old-copy-left'
    | 'book-failed';
export interface MigrationOutcome {
    readonly name: SecretName;
    readonly status: MigrationStatus;
}

/** What each failure of a port means here. A port that throws is that secret failing, never the whole run. */
const ask = <T>(work: () => Promise<T>, failed: T): Promise<T> => work().catch(() => failed);

async function finish(source: MigrationSource, book: MigrationBook): Promise<MigrationStatus> {
    const removed = await source.old.remove().then(() => true, () => false);
    if (!removed) return 'old-copy-left';
    return (await book.write(source.name, 'done').then(() => true, () => false)) ? 'moved' : 'book-failed';
}

async function moveOne(source: MigrationSource, vault: HostVault, book: MigrationBook, state: MigrationState | undefined): Promise<MigrationStatus> {
    const { name, old } = source;
    if (state === 'done') return 'already';

    const read = await ask<OldRead>(() => old.read(), { kind: 'unreadable' });
    if (read.kind === 'unreadable' || (read.kind === 'value' && read.value.length === 0)) return 'old-copy-unreadable';
    if (read.kind === 'none') {
        return (await book.write(name, 'done').then(() => true, () => false)) ? (state === 'verified' ? 'moved' : 'nothing') : 'book-failed';
    }

    if (state === 'verified') {
        // Confirmed by an earlier launch. `different` is a renewed key, which is why the old copy can go and is never written back.
        const now = await ask<Comparison>(() => vault.compare(name, read.value), 'unavailable');
        if (now === 'unavailable') return 'keychain-unavailable';
        if (now === 'missing') return 'confirmed-entry-missing';
        return finish(source, book);
    }

    // Before the store is asked, so this says what is wrong: a refusal there reads as a keychain that did not answer. Kept where it is, and said on every launch.
    if (read.value.length > MAX_SECRET_CHARS) return 'too-large';
    const stored = await ask<KeychainResult>(() => vault.store(name, read.value), { ok: false, reason: '' });
    if (!stored.ok) return 'keychain-unavailable';
    const back = await ask<Comparison>(() => vault.compare(name, read.value), 'unavailable');
    if (back === 'unavailable') return 'keychain-unavailable';
    if (back !== 'same') return 'read-back-differs';
    // Durably recorded BEFORE the delete: what remembers this has been confirmed.
    if (!(await book.write(name, 'verified').then(() => true, () => false))) return 'book-failed';
    return finish(source, book);
}

/** One migration at a time per book, so two callers in one process cannot both write. A new launch has a new book. */
const running = new WeakMap<MigrationBook, Promise<unknown>>();

export function migrateSecrets(sources: readonly MigrationSource[], vault: HostVault, book: MigrationBook): Promise<MigrationOutcome[]> {
    const run = async (): Promise<MigrationOutcome[]> => {
        let states: Record<string, MigrationState>;
        try {
            states = await book.read();
        } catch {
            // It might say this already ran, so nothing is touched.
            return sources.map(({ name }) => ({ name, status: 'book-failed' as const }));
        }
        const outcomes: MigrationOutcome[] = [];
        for (const source of sources) {
            const state = Object.hasOwn(states, source.name) ? states[source.name] : undefined;
            outcomes.push({ name: source.name, status: await moveOne(source, vault, book, state) });
        }
        return outcomes;
    };
    const work = (running.get(book) ?? Promise.resolve()).then(run, run);
    running.set(book, work);
    return work;
}

export interface SourceGroup {
    readonly file: string;
    readonly covers: string;
    readonly sources: () => Promise<readonly MigrationSource[]>;
}
// RED: as it behaves today, one rejection takes all of them.
export async function gatherSources(groups: readonly SourceGroup[]): Promise<MigrationSource[]> {
    return (await Promise.all(groups.map((group) => group.sources()))).flat();
}

// RED: the shape only.
export function stuckLines(_outcomes: readonly MigrationOutcome[], _said: Set<string>): string[] { return []; }

/** The host's half, over its keychain. It reads and compares here, and answers in one word. */
export function hostVault(keychain: Pick<Keychain, 'get' | 'set'>): HostVault {
    return {
        store: (name, value) => keychain.set(name, value),
        compare: async (name, value) => {
            const read = await keychain.get(name);
            if (read.kind === 'unavailable') return 'unavailable';
            if (read.kind === 'missing') return 'missing';
            return read.value === value ? 'same' : 'different';
        },
    };
}

const STATES: ReadonlySet<unknown> = new Set<MigrationState>(['verified', 'done']);

/** Names and states, never a value. Each write is atomic and durable (store.ts) before the step that depends on it runs. */
export function fileMigrationBook(file: string): MigrationBook {
    const load = async (): Promise<Record<string, MigrationState>> => {
        let text: string;
        try {
            text = await readFile(file, 'utf8');
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
            throw error;
        }
        const parsed = JSON.parse(text) as { version?: unknown; secrets?: unknown } | null;
        const secrets = parsed?.secrets;
        if (parsed?.version !== 1 || typeof secrets !== 'object' || secrets === null || Array.isArray(secrets)) throw new Error(`${file} is not a migration book`);
        if (Object.values(secrets).some((state) => !STATES.has(state))) throw new Error(`${file} holds a state it should not`);
        return secrets as Record<string, MigrationState>;
    };
    let writes: Promise<unknown> = Promise.resolve();
    return {
        read: load,
        write: (name, state) => {
            const run = async (): Promise<void> => {
                const secrets = await load();
                // Forward only: `done` is never taken back.
                if (secrets[name] === 'done') return;
                await writeJsonAtomic(file, { version: 1, secrets: { ...secrets, [name]: state } });
            };
            const work = writes.then(run, run);
            writes = work.catch(() => {});
            return work;
        },
    };
}
