import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
    genieOsWorkspacePath,
    legacyGenieOsWorkspacePath,
    migrateLegacyGenieOsWorkspace,
} from '../os-workspace';

/**
 * The workstation operator gets a ROOT OF ITS OWN, outside `userData`.
 *
 * It lived at `<userData>/genie-os.agi`, which put the operator's memory inside
 * the directory Reset Workstation empties — the one folder on the machine whose
 * whole purpose is to be deleted. `~/.gosa` is outside that boundary, so a reset
 * cannot reach it: the operator keeps its notes across a reset it performed
 * itself, and Genie needs no `PRESERVED_ENTRIES` entry to arrange it.
 *
 * The move is only safe if the old folder's contents come with it. `.ai/memory`
 * is the operator's accumulated knowledge of this machine; losing it silently
 * would be the worst possible outcome of a refactor whose point is to stop
 * losing things.
 */
describe('the operator envelope roots at ~/.gosa', () => {
    it('is a dotfolder in the home directory, not a folder in userData', () => {
        const home = path.join('C:', 'Users', 'wishborn');

        expect(genieOsWorkspacePath(home)).toBe(path.join(home, '.gosa'));
    });

    it('still knows where the legacy envelope was, so it can be migrated', () => {
        const userData = path.join('C:', 'Users', 'wishborn', 'AppData', 'Genie');

        expect(legacyGenieOsWorkspacePath(userData)).toBe(
            path.join(userData, 'genie-os.agi'),
        );
    });
});

describe('migrating <userData>/genie-os.agi to ~/.gosa', () => {
    let root = '';
    let userData = '';
    let home = '';

    beforeEach(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'gosa-migrate-'));
        userData = path.join(root, 'userData');
        home = path.join(root, 'home');
        fs.mkdirSync(userData, { recursive: true });
        fs.mkdirSync(home, { recursive: true });
    });

    afterEach(() => {
        fs.rmSync(root, { recursive: true, force: true });
    });

    /** A legacy envelope with memory, knowledge and a git directory in it. */
    function seedLegacy(): string {
        const legacy = path.join(userData, 'genie-os.agi');
        fs.mkdirSync(path.join(legacy, '.ai', 'memory'), { recursive: true });
        fs.mkdirSync(path.join(legacy, '.git'), { recursive: true });
        fs.writeFileSync(path.join(legacy, 'project.json'), '{"name":"Genie OS"}');
        fs.writeFileSync(
            path.join(legacy, '.ai', 'memory', 'toolchain.md'),
            '# php 8.4 lives in toolchain/php/8.4\n',
        );
        fs.writeFileSync(path.join(legacy, '.git', 'HEAD'), 'ref: refs/heads/main\n');
        return legacy;
    }

    it('brings the operator memory across byte for byte', () => {
        const legacy = seedLegacy();

        const result = migrateLegacyGenieOsWorkspace(userData, home);

        expect(result.migrated).toBe(true);
        expect(
            fs.readFileSync(
                path.join(home, '.gosa', '.ai', 'memory', 'toolchain.md'),
                'utf8',
            ),
        ).toBe(fs.readFileSync(path.join(legacy, '.ai', 'memory', 'toolchain.md'), 'utf8'));
        // The git history travels too — the envelope is git-backed and the
        // operator's notes are commits in it.
        expect(fs.existsSync(path.join(home, '.gosa', '.git', 'HEAD'))).toBe(true);
    });

    it('NEVER deletes the source — the old folder is still there afterwards', () => {
        const legacy = seedLegacy();

        migrateLegacyGenieOsWorkspace(userData, home);

        expect(fs.existsSync(path.join(legacy, '.ai', 'memory', 'toolchain.md'))).toBe(true);
    });

    it('leaves no staging directory behind', () => {
        seedLegacy();

        migrateLegacyGenieOsWorkspace(userData, home);

        expect(fs.readdirSync(home).sort()).toEqual(['.gosa']);
    });

    it('is idempotent — a second run copies nothing and changes nothing', () => {
        seedLegacy();
        migrateLegacyGenieOsWorkspace(userData, home);
        fs.writeFileSync(
            path.join(home, '.gosa', '.ai', 'memory', 'toolchain.md'),
            'edited after the move\n',
        );

        const again = migrateLegacyGenieOsWorkspace(userData, home);

        expect(again.migrated).toBe(false);
        expect(
            fs.readFileSync(path.join(home, '.gosa', '.ai', 'memory', 'toolchain.md'), 'utf8'),
        ).toBe('edited after the move\n');
    });

    it('never clobbers an existing ~/.gosa', () => {
        seedLegacy();
        fs.mkdirSync(path.join(home, '.gosa'), { recursive: true });
        fs.writeFileSync(path.join(home, '.gosa', 'project.json'), '{"name":"mine"}');

        const result = migrateLegacyGenieOsWorkspace(userData, home);

        expect(result.migrated).toBe(false);
        expect(fs.readFileSync(path.join(home, '.gosa', 'project.json'), 'utf8')).toBe(
            '{"name":"mine"}',
        );
    });

    it('does nothing on a fresh install with no legacy envelope', () => {
        // POSITIVE CONTROL for the whole migration: a machine that never had the
        // old folder must not be handed a half-made one, and must not report a
        // migration that did not happen.
        const result = migrateLegacyGenieOsWorkspace(userData, home);

        expect(result.migrated).toBe(false);
        expect(fs.existsSync(path.join(home, '.gosa'))).toBe(false);
    });
});
