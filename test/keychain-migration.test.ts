import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Keychain, type KeyringModule } from '../src/main/keychain.js';
import { fileMigrationBook, hostVault, migrateSecrets, type HostVault, type MigrationBook, type MigrationSource, type OldRead } from '../src/main/keychain-migration.js';

/**
 * THE ONE-TIME MIGRATION (P3.4 cut b; plan §13): the one place a bug loses a person's sign-ins. The window decrypts each secret
 * once and hands it to the host, the host writes it to the keychain and reads it back, and only then does the window delete
 * its copy.
 *
 * A CRASH HERE IS A REAL ONE. A port "crashes" by never returning, so nothing after that point runs: no catch, no finally, no
 * later step. An injected exception would prove only that the engine handles exceptions. Then a NEW engine runs over what is
 * left, which is what the next launch does.
 */

const NAME = 'tynn/agent/a1' as const;
const SECRET = 'rpk_01ARZ3NDEKTSV4RRFFQ69G5FAV.0123456789abcdef';

type Step = 'read-old' | 'write' | 'read-back' | 'book-verified' | 'delete-old' | 'book-done';

/** The world that survives a crash: the old copy, the keychain and the book. */
class World {
    old: string | null = SECRET;
    oldUnreadable = false;
    keychain = new Map<string, string>();
    available = true;
    states: Record<string, 'verified' | 'done'> = {};
    bookBroken = false;
    bookWriteFails = false;
    deleteFails = false;
    writes = 0;
    deletes = 0;
    oldReads = 0;
    /** What a write really stores, where it differs from what it was given. */
    stores: (value: string) => string = (value) => value;
    #crashAt: Step | null = null;
    #crashed: (() => void) | null = null;

    /** Runs the engine until it reaches `step`, then the process is gone. */
    runUntilCrash(step: Step, sources = [this.source()]): Promise<void> {
        this.#crashAt = step;
        return new Promise<void>((resolve) => {
            this.#crashed = resolve;
            void migrateSecrets(sources, this.vault(), this.book());
        }).finally(() => { this.#crashAt = null; this.#crashed = null; });
    }

    /** Before the step's effect (a crash "before the write" has not written). */
    #before(step: Step): Promise<void> | null {
        if (this.#crashAt !== step) return null;
        this.#crashed?.();
        return new Promise<void>(() => {});
    }

    source(name: MigrationSource['name'] = NAME): MigrationSource {
        return {
            name,
            old: {
                read: async (): Promise<OldRead> => {
                    await this.#before('read-old');
                    this.oldReads++;
                    if (this.oldUnreadable) return { kind: 'unreadable' };
                    return this.old === null ? { kind: 'none' } : { kind: 'value', value: this.old };
                },
                remove: async () => {
                    await this.#before('delete-old');
                    this.deletes++;
                    if (this.deleteFails) throw new Error('the file is held open');
                    this.old = null;
                },
            },
        };
    }

    vault(): HostVault {
        return {
            store: async (name, value) => {
                await this.#before('write');
                if (!this.available) return { ok: false, reason: 'no secret service' };
                this.writes++;
                this.keychain.set(name, this.stores(value));
                return { ok: true };
            },
            compare: async (name, value) => {
                await this.#before('read-back');
                if (!this.available) return 'unavailable';
                const held = this.keychain.get(name);
                return held === undefined ? 'missing' : held === value ? 'same' : 'different';
            },
        };
    }

    book(): MigrationBook {
        return {
            read: async () => {
                if (this.bookBroken) throw new Error('the book cannot be read');
                return { ...this.states };
            },
            write: async (name, state) => {
                await this.#before(state === 'verified' ? 'book-verified' : 'book-done');
                if (this.bookWriteFails) throw new Error('the disk is full');
                this.states[name] = state;
            },
        };
    }

    run(sources = [this.source()]) {
        return migrateSecrets(sources, this.vault(), this.book());
    }

    /** The person can still sign in with what is left. */
    workingCopy(): string | null {
        return this.old ?? this.keychain.get(NAME) ?? null;
    }
}

describe('a clean run', () => {
    it('moves the secret: in the keychain byte for byte, the old copy gone, the book says done', async () => {
        const world = new World();
        expect(await world.run()).toEqual([{ name: NAME, status: 'moved' }]);
        expect(world.keychain.get(NAME)).toBe(SECRET);
        expect(world.old).toBeNull();
        expect(world.states[NAME]).toBe('done');
    });

    it('nothing to move: no write, no delete, and it is never asked again', async () => {
        const world = new World();
        world.old = null;
        expect(await world.run()).toEqual([{ name: NAME, status: 'nothing' }]);
        expect([world.writes, world.deletes]).toEqual([0, 0]);
        expect(world.states[NAME]).toBe('done');
    });
});

describe('a crash at every step leaves a working copy, and the next launch finishes it', () => {
    const STEPS: readonly Step[] = ['read-old', 'write', 'read-back', 'book-verified', 'delete-old', 'book-done'];

    it.each(STEPS)('crash at %s', async (step) => {
        const world = new World();
        await world.runUntilCrash(step);
        // The sign-in survives the crash itself.
        expect(world.workingCopy()).toBe(SECRET);
        // The next launch.
        await world.run();
        expect(world.keychain.get(NAME)).toBe(SECRET);
        expect(world.old).toBeNull();
        expect(world.states[NAME]).toBe('done');
    });

    it('CONTROL: each crash really stopped the run where it says (the gauge can tell these steps apart)', async () => {
        const reached: Record<string, unknown> = {};
        for (const step of STEPS) {
            const world = new World();
            await world.runUntilCrash(step);
            reached[step] = [world.writes, world.keychain.has(NAME), world.states[NAME] ?? null, world.old !== null];
        }
        expect(reached).toEqual({
            'read-old': [0, false, null, true],
            write: [0, false, null, true],
            'read-back': [1, true, null, true],
            'book-verified': [1, true, null, true],
            'delete-old': [1, true, 'verified', true],
            'book-done': [1, true, 'verified', false],
        });
    });

    it.each(['read-old', 'write', 'read-back', 'book-verified'] as const)('crash at %s: the old copy is untouched, since nothing has been confirmed yet', async (step) => {
        const world = new World();
        await world.runUntilCrash(step);
        expect(world.old).toBe(SECRET);
        expect(world.deletes).toBe(0);
    });
});

describe('it never runs twice', () => {
    it('after done: the old copy is not even read, and the keychain is not written', async () => {
        const world = new World();
        await world.run();
        const before = [world.writes, world.oldReads, world.deletes];
        expect(await world.run()).toEqual([{ name: NAME, status: 'already' }]);
        expect([world.writes, world.oldReads, world.deletes]).toEqual(before);
    });

    it('after done, a key that was renewed stays; an old copy that turned up cannot overwrite it', async () => {
        const world = new World();
        await world.run();
        world.keychain.set(NAME, 'the-renewed-key');
        world.old = SECRET;
        await world.run();
        expect(world.keychain.get(NAME)).toBe('the-renewed-key');
    });

    it('two runs at once write once', async () => {
        const world = new World();
        // One book, as in one process: a NEW book is what a new launch has (and what a crash leaves behind).
        const book = world.book();
        const vault = world.vault();
        const [a, b] = await Promise.all([migrateSecrets([world.source()], vault, book), migrateSecrets([world.source()], vault, book)]);
        expect(world.writes).toBe(1);
        expect([a[0]?.status, b[0]?.status].sort()).toEqual(['already', 'moved']);
    });

    it('confirmed, then a crash before the delete, then the key is renewed: the next launch deletes the old copy and does NOT write it back', async () => {
        const world = new World();
        await world.runUntilCrash('delete-old');
        world.keychain.set(NAME, 'the-renewed-key');
        await world.run();
        expect(world.keychain.get(NAME)).toBe('the-renewed-key');
        expect(world.old).toBeNull();
        expect(world.writes).toBe(1);
    });
});

describe('the old copy is never deleted until the read-back matches, byte for byte', () => {
    const NOT_THE_SAME: ReadonlyArray<readonly [string, (value: string) => string]> = [
        ['one character changed', (v) => `${v.slice(0, -1)}X`],
        ['cut short (a store with a size limit)', (v) => v.slice(0, 16)],
        ['a trailing newline', (v) => `${v}\n`],
        ['a different case', (v) => v.toUpperCase()],
    ];

    it.each(NOT_THE_SAME)('%s: kept, not confirmed, and said', async (_label, stores) => {
        const world = new World();
        world.stores = stores;
        expect(await world.run()).toEqual([{ name: NAME, status: 'read-back-differs' }]);
        expect(world.old).toBe(SECRET);
        expect(world.deletes).toBe(0);
        expect(world.states[NAME]).toBeUndefined();
    });

    it('the keychain took the write and then has nothing: kept', async () => {
        const world = new World();
        world.stores = (value) => value;
        const vault = world.vault();
        const result = await migrateSecrets([world.source()], { ...vault, compare: async () => 'missing' }, world.book());
        expect(result[0]?.status).toBe('read-back-differs');
        expect(world.old).toBe(SECRET);
    });

    it('a bad read-back is tried again at the next launch, and a good one finishes', async () => {
        const world = new World();
        world.stores = (value) => value.slice(0, 16);
        await world.run();
        world.stores = (value) => value;
        expect(await world.run()).toEqual([{ name: NAME, status: 'moved' }]);
        expect(world.keychain.get(NAME)).toBe(SECRET);
    });

    it('before it is confirmed the old copy is the truth: a stale keychain entry from an earlier install is replaced, never believed', async () => {
        const world = new World();
        world.keychain.set(NAME, 'left-by-an-earlier-install');
        await world.run();
        expect(world.keychain.get(NAME)).toBe(SECRET);
    });
});

describe('no keychain: refused, and nothing moves (decision 3)', () => {
    it('the old copy stays, the book stays empty, and the status says why', async () => {
        const world = new World();
        world.available = false;
        expect(await world.run()).toEqual([{ name: NAME, status: 'keychain-unavailable' }]);
        expect(world.old).toBe(SECRET);
        expect(world.states).toEqual({});
    });

    it('it comes back: the next launch moves it', async () => {
        const world = new World();
        world.available = false;
        await world.run();
        world.available = true;
        expect(await world.run()).toEqual([{ name: NAME, status: 'moved' }]);
    });

    it('the keychain goes away between the write and the read-back: kept', async () => {
        const world = new World();
        const vault = world.vault();
        const result = await migrateSecrets([world.source()], { ...vault, compare: async () => 'unavailable' }, world.book());
        expect(result[0]?.status).toBe('keychain-unavailable');
        expect(world.old).toBe(SECRET);
        expect(world.states).toEqual({});
    });

    it('confirmed earlier, and the keychain is locked now: the old copy stays until it answers', async () => {
        const world = new World();
        await world.runUntilCrash('delete-old');
        world.available = false;
        expect((await world.run())[0]?.status).toBe('keychain-unavailable');
        expect(world.old).toBe(SECRET);
    });

    it('confirmed earlier, and the entry is gone from the keychain: the old copy is NOT deleted, and that is said', async () => {
        const world = new World();
        await world.runUntilCrash('delete-old');
        world.keychain.clear();
        expect((await world.run())[0]?.status).toBe('confirmed-entry-missing');
        expect(world.old).toBe(SECRET);
    });
});

describe('what else can go wrong keeps the old copy', () => {
    it('the old copy cannot be unlocked: nothing is written or deleted, and it is tried again', async () => {
        const world = new World();
        world.oldUnreadable = true;
        expect(await world.run()).toEqual([{ name: NAME, status: 'old-copy-unreadable' }]);
        expect([world.writes, world.deletes]).toEqual([0, 0]);
        expect(world.states).toEqual({});
        world.oldUnreadable = false;
        expect((await world.run())[0]?.status).toBe('moved');
    });

    it('an empty old copy is not a secret to move, and not one to delete', async () => {
        const world = new World();
        world.old = '';
        expect((await world.run())[0]?.status).toBe('old-copy-unreadable');
        expect(world.old).toBe('');
    });

    it('the book cannot be read: NOTHING is touched, because it might say this already ran', async () => {
        const world = new World();
        world.bookBroken = true;
        expect(await world.run()).toEqual([{ name: NAME, status: 'book-failed' }]);
        expect([world.oldReads, world.writes, world.deletes]).toEqual([0, 0, 0]);
    });

    it('the book cannot be written: the old copy stays, since nothing would remember it was confirmed', async () => {
        const world = new World();
        world.bookWriteFails = true;
        expect((await world.run())[0]?.status).toBe('book-failed');
        expect(world.old).toBe(SECRET);
    });

    it('the delete fails: it is said, the keychain holds the secret, and the next launch deletes it without writing again', async () => {
        const world = new World();
        world.deleteFails = true;
        expect((await world.run())[0]?.status).toBe('old-copy-left');
        expect(world.keychain.get(NAME)).toBe(SECRET);
        world.deleteFails = false;
        expect((await world.run())[0]?.status).toBe('moved');
        expect(world.old).toBeNull();
        expect(world.writes).toBe(1);
    });

    it('one secret that cannot move does not hold back the others, and each answers for itself', async () => {
        const world = new World();
        const bad: MigrationSource = { name: 'github/access', old: { read: async () => ({ kind: 'unreadable' }), remove: async () => { throw new Error('never called'); } } };
        const result = await world.run([bad, world.source()]);
        expect(result).toEqual([{ name: 'github/access', status: 'old-copy-unreadable' }, { name: NAME, status: 'moved' }]);
    });

    it('a port that throws is that secret failing, not the whole run', async () => {
        const world = new World();
        const thrower: MigrationSource = { name: 'github/access', old: { read: async () => { throw new Error('boom'); }, remove: async () => {} } };
        const result = await world.run([thrower, world.source()]);
        expect(result[0]).toEqual({ name: 'github/access', status: 'old-copy-unreadable' });
        expect(result[1]?.status).toBe('moved');
    });

    it('no answer carries a value', async () => {
        const world = new World();
        world.stores = () => 'something-else';
        expect(JSON.stringify(await world.run())).not.toContain(SECRET);
    });
});

describe('the host reads back: the real Keychain behind the vault', () => {
    function fakeLibrary() {
        const held = new Map<string, string>();
        const failing = { value: false };
        const module: KeyringModule = {
            AsyncEntry: class {
                readonly #name: string;
                constructor(_service: string, name: string) { this.#name = name; }
                async getPassword() { if (failing.value) throw new Error('no secret service'); return held.get(this.#name) ?? null; }
                async setPassword(password: string) { if (failing.value) throw new Error('no secret service'); held.set(this.#name, password); }
                async deletePassword() { return held.delete(this.#name); }
            },
        };
        return { held, failing, module };
    }

    it('a full move through it; compare answers same, different, missing and unavailable', async () => {
        const lib = fakeLibrary();
        const vault = hostVault(new Keychain(async () => lib.module));
        expect(await vault.compare(NAME, SECRET)).toBe('missing');
        expect(await vault.store(NAME, SECRET)).toEqual({ ok: true });
        expect(await vault.compare(NAME, SECRET)).toBe('same');
        expect(await vault.compare(NAME, `${SECRET}x`)).toBe('different');
        lib.failing.value = true;
        expect(await vault.compare(NAME, SECRET)).toBe('unavailable');
        expect((await vault.store(NAME, SECRET)).ok).toBe(false);
    });

    it('compare gives no value back: the host says same or not, and the secret does not cross the link again', async () => {
        const lib = fakeLibrary();
        const vault = hostVault(new Keychain(async () => lib.module));
        await vault.store(NAME, SECRET);
        expect(JSON.stringify(await vault.compare(NAME, 'wrong'))).not.toContain(SECRET);
    });
});

describe('the book on disk', () => {
    let dir: string;
    beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'keychain-book-')); });
    afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

    it('no file is an empty book; what is written is read by a NEW book (another launch)', async () => {
        const file = join(dir, 'keychain-migration.json');
        expect(await fileMigrationBook(file).read()).toEqual({});
        await fileMigrationBook(file).write(NAME, 'verified');
        await fileMigrationBook(file).write('github/access', 'done');
        expect(await fileMigrationBook(file).read()).toEqual({ [NAME]: 'verified', 'github/access': 'done' });
    });

    it('a state moves forward and never back', async () => {
        const file = join(dir, 'keychain-migration.json');
        const book = fileMigrationBook(file);
        await book.write(NAME, 'done');
        await book.write(NAME, 'verified');
        expect((await book.read())[NAME]).toBe('done');
    });

    it('a file that cannot be understood REJECTS: it is not an empty book', async () => {
        const file = join(dir, 'keychain-migration.json');
        writeFileSync(file, '{ not json');
        await expect(fileMigrationBook(file).read()).rejects.toThrow();
        writeFileSync(file, JSON.stringify({ version: 99, secrets: {} }));
        await expect(fileMigrationBook(file).read()).rejects.toThrow();
        writeFileSync(file, JSON.stringify({ version: 1, secrets: { [NAME]: 'perhaps' } }));
        await expect(fileMigrationBook(file).read()).rejects.toThrow();
    });

    it('writes on an unreadable book are refused too, so they cannot wipe what it said', async () => {
        const file = join(dir, 'keychain-migration.json');
        writeFileSync(file, '{ not json');
        await expect(fileMigrationBook(file).write(NAME, 'done')).rejects.toThrow();
        expect(readFileSync(file, 'utf8')).toBe('{ not json');
    });

    it('holds names and states only', async () => {
        const file = join(dir, 'keychain-migration.json');
        const world = new World();
        await migrateSecrets([world.source()], world.vault(), fileMigrationBook(file));
        expect(existsSync(file)).toBe(true);
        expect(readFileSync(file, 'utf8')).not.toContain(SECRET);
    });
});

describe('not switched on (each secret switches on with its reader)', () => {
    const strip = (text: string) => text.split(/\r?\n/).map((line) => line.replace(/^\s*(\/\/|\*|\/\*).*$/, '')).join('\n');

    it('nothing runs it yet', () => {
        for (const file of ['src/main/main.ts', 'src/main/compose.ts', 'src/main/genie-host.ts', 'src/main/session-engine-server.ts', 'src/main/session-engine-client.ts']) {
            expect(strip(readFileSync(file, 'utf8')), file).not.toMatch(/keychain-migration/);
        }
    });

    it('it has no fallback to write to: the engine touches no file but its book', () => {
        const code = strip(readFileSync('src/main/keychain-migration.ts', 'utf8'));
        expect(code).not.toMatch(/writeFile|appendFile|safeStorage|from 'electron'/);
    });
});
