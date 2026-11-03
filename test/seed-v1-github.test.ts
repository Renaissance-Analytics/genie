import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { v1GithubLogin } from '../src/core/github.js';
import { readV1Settings } from '../src/main/v1-settings.js';

/**
 * S10's PROFILE (plan §13): a Genie 1 database holding only a GitHub login. scripts/upgrade-v1-github-acceptance-cdp.mjs seeds it and watches it move. What is checked here is that the rows the seed
 * writes are the rows the product reads: a seed in the wrong shape would read as "no Genie 1 login", and the acceptance would be about nothing.
 */
describe('seed-v1-db.mjs --github', () => {
    let dir: string;
    let db: string;
    const seed = (...args: string[]) => execFileSync(process.execPath, ['--no-warnings', 'scripts/seed-v1-db.mjs', db, ...args], { encoding: 'utf8' });
    beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'seed-v1-')); db = join(dir, 'genie.db'); });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    it('writes a database with only a settings table, and what the product reads from it is that login', () => {
        seed('--github', 'sealed-access', 'sealed-refresh', 'vm-person');
        expect(existsSync(db)).toBe(true);
        expect(v1GithubLogin(readV1Settings(db))).toEqual({ tokenEnc: 'sealed-access', refreshEnc: 'sealed-refresh', login: 'vm-person' });
    });

    it('prints no sealed value', () => {
        const printed = seed('--github', 'sealed-access', 'sealed-refresh', 'vm-person');
        expect(printed).toContain('vm-person');
        expect(printed).not.toContain('sealed-');
    });

    it('asked for less than all three, it refuses and writes nothing', () => {
        expect(() => execFileSync(process.execPath, ['--no-warnings', 'scripts/seed-v1-db.mjs', db, '--github', 'sealed-access'], { stdio: 'ignore' })).toThrow();
        expect(existsSync(db)).toBe(false);
    });
});
