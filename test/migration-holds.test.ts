import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { migrateSecrets, type HostVault, type MigrationBook, type MigrationSource, type MigrationState } from '../src/main/keychain-migration.js';
import { holdMigration, type MigrationPorts } from '../src/main/migration-holds.js';
import { until } from './helpers/until.js';

/**
 * THE TEST BUILD THAT HOLDS AT EACH STEP OF THE MOVE (plan §13, S4: a crash at each step leaves a working copy). scripts/upgrade-crash-acceptance.mjs kills a real window at each hold. These say
 * the holds land where their names say, wrap the ports and leave the engine as it ships, and do nothing at all in a build without the flag. test/keychain-migration.test.ts holds the engine itself.
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
    ports = (): MigrationPorts => ({ sources: this.sources(), vault: this.vault(), book: this.book() });
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

    // Held on the SECOND secret, so each also shows the first one finished and untouched by what follows.
    it.each([
        { step: 'before-write', keychain: false, old: true, state: undefined },
        { step: 'after-write', keychain: true, old: true, state: undefined },
        { step: 'after-read-back', keychain: true, old: true, state: undefined },
        { step: 'after-book', keychain: true, old: true, state: 'verified' },
        { step: 'after-delete', keychain: true, old: false, state: 'verified' },
    ] as const)('$step: stops there, says so, and the next launch finishes with nothing lost', async ({ step, keychain, old, state }) => {
        const world = new World();
        void migrateSecrets(...args(holdMigration(world.ports(), spec(step))));
        await until(() => existsSync(marker));
        expect(readFileSync(marker, 'utf8')).toBe(`${step}:${SECOND}`);
        // A moment for anything that should not have happened to happen.
        const compares = world.compares;
        await new Promise((r) => setTimeout(r, 20));
        expect(world.compares).toBe(compares);

        expect(world.states[FIRST]).toBe('done');
        expect(world.keychain.get(FIRST)).toBe('first-word');
        expect(world.keychain.has(SECOND)).toBe(keychain);
        expect(world.old.has(SECOND)).toBe(old);
        expect(world.states[SECOND]).toBe(state);

        // The next launch: no hold.
        const outcomes = await migrateSecrets(...args(world.ports()));
        expect(outcomes.map((o) => o.status)).toEqual(['already', 'moved']);
        expect(world.keychain.get(SECOND)).toBe('second-word');
        expect(world.old.has(SECOND)).toBe(false);
        expect(world.states[SECOND]).toBe('done');
    });

    it('after-write is past the write and before the read-back; after-read-back is past it (the two differ only there)', async () => {
        const atWrite = new World();
        void migrateSecrets(...args(holdMigration(atWrite.ports(), spec('after-write', FIRST))));
        await until(() => existsSync(marker));
        expect(atWrite.compares).toBe(0);
        rmSync(marker);
        const atBack = new World();
        void migrateSecrets(...args(holdMigration(atBack.ports(), spec('after-read-back', FIRST))));
        await until(() => existsSync(marker));
        expect(atBack.compares).toBe(1);
    });

    it('only the named secret is held: with a name nothing has, all of it moves', async () => {
        const world = new World();
        const outcomes = await migrateSecrets(...args(holdMigration(world.ports(), spec('before-write', 'tynn/pairing'))));
        expect(outcomes.map((o) => o.status)).toEqual(['moved', 'moved']);
        expect(existsSync(marker)).toBe(false);
    });

    it.each([
        ['no hold asked for', {}],
        ['no marker file', { GENIE_TEST_MIGRATION_HOLD: `before-write:${SECOND}` }],
        ['a step that does not exist', { GENIE_TEST_MIGRATION_HOLD: `somewhere:${SECOND}`, GENIE_TEST_MIGRATION_HOLD_FILE: 'x' }],
    ])('%s: the ports as they were', (_, env) => {
        const ports = new World().ports();
        expect(holdMigration(ports, env)).toBe(ports);
    });
});

describe('in any other build', () => {
    it('the ports as they were, whatever the environment says', () => {
        const ports = new World().ports();
        expect(holdMigration(ports, { GENIE_TEST_MIGRATION_HOLD: `before-write:${FIRST}`, GENIE_TEST_MIGRATION_HOLD_FILE: 'x' })).toBe(ports);
    });

    it('the flag is built in only when asked for, and nothing that ships asks', () => {
        expect(readFileSync('vite.main.config.ts', 'utf8')).toMatch(/__GENIE_TEST_HOLDS__: process\.env\.GENIE_TEST_HOLDS === '1' \? 'true' : 'false'/);
        for (const file of ['scripts/ci/linux.sh', 'scripts/ci/windows.ps1', '.github/workflows/release.yml', 'package.json', 'electron-builder.yml']) {
            expect(readFileSync(file, 'utf8'), file).not.toContain('GENIE_TEST_HOLDS');
        }
    });
});

describe('wired', () => {
    it('the move runs through it, and the engine itself knows nothing about it', () => {
        expect(readFileSync('src/main/compose.ts', 'utf8')).toMatch(/migrateSecrets\(\.\.\.[^\n]*holdMigration\(/);
        expect(readFileSync('src/main/keychain-migration.ts', 'utf8')).not.toMatch(/migration-holds|holdMigration/);
    });
});

function args(ports: MigrationPorts): [MigrationSource[], HostVault, MigrationBook] {
    return [[...ports.sources], ports.vault, ports.book];
}
