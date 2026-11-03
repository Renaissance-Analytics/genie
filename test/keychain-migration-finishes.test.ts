import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { githubSealedSources } from '../src/main/github-account.js';
import { fileMigrationBook, migrateSecrets, type HostVault, type MigrationBook, type MigrationState } from '../src/main/keychain-migration.js';

/**
 * A CRASH JUST PAST THE DELETE (batch FF, S4 after-delete: `"github/refresh":"verified"` after the next launch, with the secret safe and no seal left). Each source is found by its seal, so with the seal
 * gone nothing names that secret any more and its row stayed `verified` on every launch. The book's own rule says what it means: confirmed, and only the delete and the word `done` were left.
 */
const NAME = 'github/refresh' as const;
const vaultThatMustNotBeAsked: HostVault = {
    store: async () => { throw new Error('asked to store'); },
    compare: async () => { throw new Error('asked to compare'); },
};
function memoryBook(states: Record<string, MigrationState>, failing = false): MigrationBook & { writes: string[] } {
    const writes: string[] = [];
    return {
        writes,
        read: async () => ({ ...states }),
        write: async (name, state) => { if (failing) throw new Error('disk full'); writes.push(`${name}=${state}`); states[name] = state; },
    };
}

describe('a row confirmed, with nothing left to name it', () => {
    it('is finished: the book says done, and the keychain is not asked', async () => {
        const states: Record<string, MigrationState> = { [NAME]: 'verified' };
        expect(await migrateSecrets([], vaultThatMustNotBeAsked, memoryBook(states))).toEqual([{ name: NAME, status: 'moved' }]);
        expect(states[NAME]).toBe('done');
    });

    it('the book not taking it is said, as for any other row', async () => {
        expect(await migrateSecrets([], vaultThatMustNotBeAsked, memoryBook({ [NAME]: 'verified' }, true))).toEqual([{ name: NAME, status: 'book-failed' }]);
    });

    it('a row already done is left alone: nothing written, nothing to say (the second launch changes nothing)', async () => {
        const book = memoryBook({ [NAME]: 'done' });
        expect(await migrateSecrets([], vaultThatMustNotBeAsked, book)).toEqual([]);
        expect(book.writes).toEqual([]);
    });

    it('a row a source still names goes the way it always did, once', async () => {
        const removed: string[] = [];
        const states: Record<string, MigrationState> = { [NAME]: 'verified' };
        const vault: HostVault = { store: vaultThatMustNotBeAsked.store, compare: async () => 'same' };
        const outcomes = await migrateSecrets([{ name: NAME, old: { read: async () => ({ kind: 'value', value: 'word' }), remove: async () => { removed.push(NAME); } } }], vault, memoryBook(states));
        expect(outcomes).toEqual([{ name: NAME, status: 'moved' }]);
        expect(removed).toEqual([NAME]);
    });
});

describe('with the real files', () => {
    let dir: string;
    beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'book-finishes-')); });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    it('killed just past the delete of GitHub\'s refresh token: the next launch finishes it, and the launch after writes nothing', async () => {
        const file = join(dir, 'github.json');
        const bookFile = join(dir, 'keychain-migration.json');
        writeFileSync(file, JSON.stringify({ version: 1, state: 'signed-in', login: 'vm-person', name: null, source: 'sign-in' }));
        writeFileSync(bookFile, JSON.stringify({ version: 1, secrets: { 'github/access': 'done', [NAME]: 'verified' } }));
        const launch = async () => migrateSecrets(await githubSealedSources({ file, cipher: { decrypt: () => { throw new Error('nothing is sealed'); } } }), vaultThatMustNotBeAsked, fileMigrationBook(bookFile));

        // CONTROL: this is the state S4 found. Nothing names the row.
        expect(await githubSealedSources({ file, cipher: { decrypt: () => '' } })).toEqual([]);
        expect(await launch()).toEqual([{ name: NAME, status: 'moved' }]);
        const finished = readFileSync(bookFile, 'utf8');
        expect(JSON.parse(finished).secrets).toEqual({ 'github/access': 'done', [NAME]: 'done' });
        expect(await launch()).toEqual([]);
        expect(readFileSync(bookFile, 'utf8')).toBe(finished);
    });
});
