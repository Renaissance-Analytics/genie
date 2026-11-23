import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HostVault, MigrationBook, MigrationSource, MigrationState } from '../src/main/keychain-migration.js';
import { holdHostPorts, holdSources } from '../src/main/migration-holds.js';
import { moveAll } from './helpers/move-secrets.js';
import { until } from './helpers/until.js';

/**
 * THE TEST BUILD THAT HOLDS AT EACH STEP OF THE MOVE (plan §13, S4: a crash at each step leaves a working copy). scripts/upgrade-crash-acceptance.mjs kills a real Genie at each hold. These say
 * the holds land where their names say, wrap the ports and leave the engine as it ships, and do nothing at all in a build without the flag. test/keychain-migration.test.ts holds the engine itself.
 *
 * The move spans two processes since Tynn #959 (2g-3b): the window's delete holds at `after-book` (holdSources), genie-host's keychain and book at the other four (holdHostPorts). genie-host
 * confirms every secret before it answers, and writes `done` once the window says what it deleted, so the secret BEFORE the held one is confirmed with the batch, its old copy goes with the
 * window's deletes, and its `done` with genie-host's second half. At every hold it keeps a working copy.
 */
const FIRST = 'github/access' as const;
const SECOND = 'github/refresh' as const;

class World {
    old = new Map<string, string>([[FIRST, 'first-word'], [SECOND, 'second-word']]);
    keychain = new Map<string, string>();
    states: Record<string, MigrationState> = {};
    compares = 0;
    sources = (): MigrationSource[] => [FIRST, SECOND].map((name) => ({
        name,
        old: {
            read: async () => { const value = this.old.get(name); return value === undefined ? { kind: 'none' as const } : { kind: 'value' as const, value }; },
            remove: async () => { this.old.delete(name); },
        },
    }));
    vault = (): HostVault => ({
        store: async (name, value) => { this.keychain.set(name, value); return { ok: true }; },
        compare: async (name, value) => { this.compares += 1; const held = this.keychain.get(name); return held === undefined ? 'missing' : held === value ? 'same' : 'different'; },
    });
    book = (): MigrationBook => ({
        read: async () => ({ ...this.states }),
        write: async (name, state) => { this.states[name] = state; },
    });
}

/** The window's half and genie-host's half, each wrapped as its own process wraps it. */
function held(world: World, env: Readonly<Record<string, string | undefined>>): [MigrationSource[], HostVault, MigrationBook] {
    const host = holdHostPorts({ vault: world.vault(), book: world.book() }, env);
    return [[...holdSources(world.sources(), env)], host.vault, host.book];
}

describe('in a test build', () => {
    let dir: string;
    let marker: string;
    const spec = (step: string, name: string = SECOND) => ({ GENIE_TEST_MIGRATION_HOLD: `${step}:${name}`, GENIE_TEST_MIGRATION_HOLD_FILE: marker });
    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'migration-holds-'));
        marker = join(dir, 'held');
        vi.stubGlobal('__GENIE_TEST_HOLDS__', true);
    });
    afterEach(() => { vi.unstubAllGlobals(); rmSync(dir, { recursive: true, force: true }); });

    // Held on the SECOND secret, so each also shows what the first one has come to, and that it keeps a working copy.
    it.each([
        { step: 'before-write', keychain: false, old: true, state: undefined, first: 'verified', firstOld: true, next: ['moved', 'moved'] },
        { step: 'after-write', keychain: true, old: true, state: undefined, first: 'verified', firstOld: true, next: ['moved', 'moved'] },
        { step: 'after-read-back', keychain: true, old: true, state: undefined, first: 'verified', firstOld: true, next: ['moved', 'moved'] },
        { step: 'after-book', keychain: true, old: true, state: 'verified', first: 'verified', firstOld: false, next: ['moved', 'moved'] },
        { step: 'after-delete', keychain: true, old: false, state: 'verified', first: 'done', firstOld: false, next: ['already', 'moved'] },
    ] as const)('$step: stops there, says so, and the next launch finishes with nothing lost', async ({ step, keychain, old, state, first, firstOld, next }) => {
        const world = new World();
        void moveAll(...held(world, spec(step)));
        await until(() => existsSync(marker));
        expect(readFileSync(marker, 'utf8')).toBe(`${step}:${SECOND}`);
        // A moment for anything that should not have happened to happen.
        const compares = world.compares;
        await new Promise((r) => setTimeout(r, 20));
        expect(world.compares).toBe(compares);

        expect(world.states[FIRST]).toBe(first);
        expect(world.keychain.get(FIRST)).toBe('first-word');
        expect(world.old.has(FIRST)).toBe(firstOld);
        expect(world.keychain.has(SECOND)).toBe(keychain);
        expect(world.old.has(SECOND)).toBe(old);
        expect(world.states[SECOND]).toBe(state);

        // The next launch: no hold.
        const outcomes = await moveAll(world.sources(), world.vault(), world.book());
        expect(outcomes.map((o) => o.status)).toEqual(next);
        expect(world.keychain.get(SECOND)).toBe('second-word');
        expect(world.old.has(SECOND)).toBe(false);
        expect(world.old.has(FIRST)).toBe(false);
        expect([world.states[FIRST], world.states[SECOND]]).toEqual(['done', 'done']);
    });

    it('after-write is past the write and before the read-back; after-read-back is past it (the two differ only there)', async () => {
        const atWrite = new World();
        void moveAll(...held(atWrite, spec('after-write', FIRST)));
        await until(() => existsSync(marker));
        // The one compare before the write (no row: the security review of #2120), and no read-back yet.
        expect(atWrite.compares).toBe(1);
        rmSync(marker);
        const atBack = new World();
        void moveAll(...held(atBack, spec('after-read-back', FIRST)));
        await until(() => existsSync(marker));
        expect(atBack.compares).toBe(2);
    });

    it('only the named secret is held: with a name nothing has, all of it moves', async () => {
        const world = new World();
        const outcomes = await moveAll(...held(world, spec('before-write', 'tynn/pairing')));
        expect(outcomes.map((o) => o.status)).toEqual(['moved', 'moved']);
        expect(existsSync(marker)).toBe(false);
    });

    it.each([
        ['no hold asked for', {}],
        ['no marker file', { GENIE_TEST_MIGRATION_HOLD: `before-write:${SECOND}` }],
        ['a step that does not exist', { GENIE_TEST_MIGRATION_HOLD: `somewhere:${SECOND}`, GENIE_TEST_MIGRATION_HOLD_FILE: 'x' }],
    ])('%s: the ports as they were', (_, env) => {
        const world = new World();
        const sources = world.sources();
        const host = { vault: world.vault(), book: world.book() };
        expect(holdSources(sources, env)).toBe(sources);
        expect(holdHostPorts(host, env)).toBe(host);
    });
});

describe('in any other build', () => {
    it('the ports as they were, whatever the environment says', () => {
        const world = new World();
        const sources = world.sources();
        const host = { vault: world.vault(), book: world.book() };
        const env = { GENIE_TEST_MIGRATION_HOLD: `before-write:${FIRST}`, GENIE_TEST_MIGRATION_HOLD_FILE: 'x' };
        expect(holdSources(sources, env)).toBe(sources);
        expect(holdHostPorts(host, env)).toBe(host);
    });

    it('the flag is built in only when asked for, and nothing that ships asks', () => {
        expect(readFileSync('vite.main.config.ts', 'utf8')).toMatch(/__GENIE_TEST_HOLDS__: process\.env\.GENIE_TEST_HOLDS === '1' \? 'true' : 'false'/);
        for (const file of ['scripts/ci/linux.sh', 'scripts/ci/windows.ps1', '.github/workflows/release.yml', 'package.json', 'electron-builder.yml']) {
            expect(readFileSync(file, 'utf8'), file).not.toContain('GENIE_TEST_HOLDS');
        }
    });
});

describe('wired', () => {
    it('each half of the move runs through its holds, and the engine itself knows nothing about them', () => {
        expect(readFileSync('src/main/legacy-unsealer.ts', 'utf8')).toMatch(/sources = holdSources\(await ports\.sources\(\), ports\.env\);/);
        expect(readFileSync('src/main/host-legacy-adopt.ts', 'utf8')).toMatch(/const \{ vault, book \} = holdHostPorts\(\{ vault: ports\.vault, book: ports\.book \}, ports\.env\);/);
        expect(readFileSync('src/main/keychain-migration.ts', 'utf8')).not.toMatch(/migration-holds|holdSources|holdHostPorts/);
    });
});
