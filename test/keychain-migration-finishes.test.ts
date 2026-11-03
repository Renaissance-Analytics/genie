import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { githubSealedSources } from '../src/main/github-account.js';
import { fileMigrationBook, gatherSources, migrateSecrets, stuckLines, type HostVault, type MigrationBook, type MigrationState } from '../src/main/keychain-migration.js';
import { workstationSealedSources } from '../src/main/workstation-identity.js';

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

/**
 * ABSENT IS NOT UNREADABLE. No seal in a file that parses, or no file, is known absent: finished. A file that exists and does not parse may have a seal in it: `done` would hide that, so the row stays
 * `verified`, tries again next launch and says so. The sign-in works either way, since the keychain's copy is the one in use.
 */
describe.each([
    {
        what: 'github.json',
        name: 'github/refresh',
        fileName: 'github.json',
        parsesWithNoSeal: JSON.stringify({ version: 1, state: 'signed-in', login: 'vm-person', name: null, source: 'sign-in' }),
        sources: (file: string) => githubSealedSources({ file, cipher: { decrypt: () => { throw new Error('nothing to open'); } } }),
    },
    {
        what: 'workstation.json',
        name: 'workstation/https://tynn.ai',
        fileName: 'workstation.json',
        parsesWithNoSeal: JSON.stringify({ 'https://tynn.ai': { workstationId: 'w1' } }),
        sources: (file: string) => workstationSealedSources({ file, cipher: { decrypt: () => { throw new Error('nothing to open'); } } }),
    },
])('$what, with a row confirmed', ({ name, fileName, parsesWithNoSeal, sources }) => {
    let dir: string;
    let file: string;
    let bookFile: string;
    const launch = async () => migrateSecrets(await sources(file), vaultThatMustNotBeAsked, fileMigrationBook(bookFile));
    const row = () => JSON.parse(readFileSync(bookFile, 'utf8')).secrets[name];
    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'book-absent-'));
        file = join(dir, fileName);
        bookFile = join(dir, 'keychain-migration.json');
        writeFileSync(bookFile, JSON.stringify({ version: 1, secrets: { [name]: 'verified' } }));
    });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    it('no seal in a file that parses is known absent: finished', async () => {
        writeFileSync(file, parsesWithNoSeal);
        expect(await launch()).toEqual([{ name, status: 'moved' }]);
        expect(row()).toBe('done');
    });

    it('no file at all is known absent: finished', async () => {
        expect(await launch()).toEqual([{ name, status: 'moved' }]);
        expect(row()).toBe('done');
    });

    it('a file that does not parse: the row stays verified, and it says the file, with nothing from inside it', async () => {
        const inside = '{ "tokenEnc": "a-seal-we-can-no-longer-find';
        writeFileSync(file, inside);
        const outcomes = await launch();
        expect(row()).toBe('verified');
        expect(outcomes).toEqual([{ name: fileName, status: 'old-copy-unreadable' }]);
        expect(JSON.stringify(outcomes)).not.toContain('a-seal');
        // Untouched, for whoever comes to look.
        expect(readFileSync(file, 'utf8')).toBe(inside);
    });

    it('the file put right, the next launch finishes', async () => {
        writeFileSync(file, '{ not json');
        await launch();
        writeFileSync(file, parsesWithNoSeal);
        expect(await launch()).toEqual([{ name, status: 'moved' }]);
        expect(row()).toBe('done');
    });
});

describe('what is said about what stayed', () => {
    it('once per launch, however many times the move is tried in it; each name for itself', () => {
        const said = new Set<string>();
        const stuck = [{ name: 'github.json', status: 'old-copy-unreadable' }, { name: 'tynn/pairing', status: 'keychain-unavailable' }] as never;
        expect(stuckLines(stuck, said)).toEqual(['[keychain] github.json stays where it was: old-copy-unreadable', '[keychain] tynn/pairing stays where it was: keychain-unavailable']);
        expect(stuckLines(stuck, said)).toEqual([]);
    });

    it('a different reason for the same name is said (CONTROL: this is not silence by name)', () => {
        const said = new Set<string>();
        stuckLines([{ name: 'github/access', status: 'keychain-unavailable' }] as never, said);
        expect(stuckLines([{ name: 'github/access', status: 'read-back-differs' }] as never, said)).toEqual(['[keychain] github/access stays where it was: read-back-differs']);
    });

    it('what moved, or had nothing to move, is not said', () => {
        expect(stuckLines([{ name: 'a', status: 'moved' }, { name: 'b', status: 'nothing' }, { name: 'c', status: 'already' }] as never, new Set())).toEqual([]);
    });
});

/**
 * ONE SOURCE FAILING STOPS ONLY ITSELF. A corrupt agents.json made the whole gathering reject, so nothing moved on any launch while the file stayed corrupt, and the owner would have met the signed-out failure
 * over an unrelated file. Each answers for itself.
 */
describe('gathering the sources', () => {
    const good = { name: 'tynn/pairing' as const, old: { read: async () => ({ kind: 'value' as const, value: 'word' }), remove: async () => {} } };
    const held = new Map<string, string>();
    const vault: HostVault = { store: async (name, value) => { held.set(name, value); return { ok: true }; }, compare: async (name, value) => (held.get(name) === value ? 'same' : 'missing') };
    const gather = (...failing: string[]) => gatherSources([
        ...failing.map((file) => ({ file, covers: `${file}/`, sources: async () => { throw new Error(`${file}: the secret word is not this message`); } })),
        { file: 'tynn.json', covers: 'tynn/pairing', sources: async () => [good] },
    ]);

    it.each([['agents.json'], ['github.json'], ['workstation.json']])('%s failing: the others are still there, and it answers by its own name', async (file) => {
        const sources = await gather(file);
        expect(sources.map(({ name }) => name)).toEqual([file, 'tynn/pairing']);
        const states: Record<string, MigrationState> = {};
        expect(await migrateSecrets(sources, vault, memoryBook(states))).toEqual([{ name: file, status: 'old-copy-unreadable' }, { name: 'tynn/pairing', status: 'moved' }]);
        expect(states['tynn/pairing']).toBe('done');
        expect(states[file]).toBeUndefined();
    });

    it('all of them failing at once still answers for each', async () => {
        expect((await gather('agents.json', 'github.json', 'workstation.json')).map(({ name }) => name)).toEqual(['agents.json', 'github.json', 'workstation.json', 'tynn/pairing']);
    });

    it('what a failure said goes nowhere near the outcome: the file\'s name and a status', async () => {
        const outcomes = await migrateSecrets(await gather('agents.json'), vault, memoryBook({}));
        expect(JSON.stringify(outcomes)).not.toContain('secret word');
    });

    it('a row it covers stays verified, and one it does not cover finishes', async () => {
        const states: Record<string, MigrationState> = { 'agents.json/one': 'verified', 'github/refresh': 'verified' };
        await migrateSecrets(await gather('agents.json'), vault, memoryBook(states));
        expect(states['agents.json/one']).toBe('verified');
        expect(states['github/refresh']).toBe('done');
    });

    it('a seal that will not open, because the key changed, stops only itself', async () => {
        const file = join(mkdtempSync(join(tmpdir(), 'seal-')), 'github.json');
        writeFileSync(file, JSON.stringify({ version: 1, state: 'signed-in', login: 'p', name: null, source: 'sign-in', tokenEnc: 'YQ==', refreshEnc: 'Yg==' }));
        const sources = await gatherSources([
            { file: 'github.json', covers: 'github/', sources: () => githubSealedSources({ file, cipher: { decrypt: () => { throw new Error('Error while decrypting the ciphertext'); } } }) },
            { file: 'tynn.json', covers: 'tynn/pairing', sources: async () => [good] },
        ]);
        expect(await migrateSecrets(sources, vault, memoryBook({}))).toEqual([{ name: 'github/access', status: 'old-copy-unreadable' }, { name: 'github/refresh', status: 'old-copy-unreadable' }, { name: 'tynn/pairing', status: 'moved' }]);
        expect(JSON.parse(readFileSync(file, 'utf8')).tokenEnc).toBe('YQ==');
    });

    it('wired: the window\'s sources and the agents\' go through it', () => {
        expect(readFileSync('src/main/compose.ts', 'utf8')).toMatch(/gatherSources\(\[/);
        expect(readFileSync('src/main/main.ts', 'utf8')).toMatch(/legacySecrets: \(\) => gatherSources\(\[/);
    });
});
