import fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
    resolveEnvTarget,
    applySetEnv,
    applyCheckEnv,
    loadWorkspaceEnvVars,
    applyEnvBlock,
} from '../env-store';
import { cleanupTmpRoot, makeTmpDir } from '../../test/helpers';

afterAll(() => cleanupTmpRoot());

describe('resolveEnvTarget', () => {
    const root = '/ws';
    it('defaults to the workspace root .env', () => {
        const r = resolveEnvTarget(root);
        expect(r.ok && r.target.label).toBe('.env');
        expect(r.ok && r.target.kind).toBe('workspace');
        expect(r.ok && r.target.path).toBe(path.join(root, '.env'));
    });
    it("'workspace' is the same as default", () => {
        const r = resolveEnvTarget(root, 'workspace');
        expect(r.ok && r.target.label).toBe('.env');
    });
    it('resolves a repo target to repos/<name>/.env', () => {
        const r = resolveEnvTarget(root, 'web');
        expect(r.ok && r.target.label).toBe('repos/web/.env');
        expect(r.ok && r.target.path).toBe(path.join(root, 'repos', 'web', '.env'));
    });
    it('REJECTS traversal / nested / absolute repo names', () => {
        for (const bad of ['..', '../escape', 'a/b', 'a\\b', '/abs', '.']) {
            expect(resolveEnvTarget(root, bad).ok).toBe(false);
        }
    });
});

describe('applySetEnv + applyCheckEnv', () => {
    it('creates a gitignored workspace .env, upserts, and preserves siblings', () => {
        const dir = makeTmpDir('env-set');
        expect(applySetEnv(dir, { key: 'PORT', value: '3000' })).toEqual({ ok: true, file: '.env' });
        applySetEnv(dir, { key: 'API_TOKEN', value: 'rpk_abc.def3f2a' });
        const content = fs.readFileSync(path.join(dir, '.env'), 'utf8');
        expect(content).toContain('PORT=3000');
        expect(content).toContain('API_TOKEN=rpk_abc.def3f2a');
        // .env is gitignored.
        expect(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8')).toContain('.env');
    });

    it('presence check by default (no value leaked)', () => {
        const dir = makeTmpDir('env-presence');
        applySetEnv(dir, { key: 'API_TOKEN', value: 'rpk_secret3f2a' });
        const r = applyCheckEnv(dir, { key: 'API_TOKEN' });
        expect(r).toMatchObject({ ok: true, exists: true, isSecret: true });
        expect(r.value).toBeUndefined();
    });

    it('reports a missing key as exists:false', () => {
        const dir = makeTmpDir('env-missing');
        expect(applyCheckEnv(dir, { key: 'NOPE' })).toMatchObject({ ok: true, exists: false });
    });

    it('OBFUSCATES a detected secret to the last 4 chars when value is requested', () => {
        const dir = makeTmpDir('env-secret');
        applySetEnv(dir, { key: 'API_TOKEN', value: 'rpk_secret3f2a' });
        const r = applyCheckEnv(dir, { key: 'API_TOKEN', value: true });
        expect(r.value).toBe('••••••3f2a');
        expect(r.obfuscated).toBe(true);
    });

    it('force returns the FULL secret value', () => {
        const dir = makeTmpDir('env-force');
        applySetEnv(dir, { key: 'API_TOKEN', value: 'rpk_secret3f2a' });
        const r = applyCheckEnv(dir, { key: 'API_TOKEN', value: true, force: true });
        expect(r.value).toBe('rpk_secret3f2a');
        expect(r.obfuscated).toBe(false);
    });

    it('returns a NON-secret value in full', () => {
        const dir = makeTmpDir('env-plain');
        applySetEnv(dir, { key: 'BASE_URL', value: 'http://localhost:3000' });
        const r = applyCheckEnv(dir, { key: 'BASE_URL', value: true });
        expect(r.value).toBe('http://localhost:3000');
        expect(r.obfuscated).toBe(false);
        expect(r.isSecret).toBe(false);
    });

    it('writes/reads a repo .env when the repo dir exists; rejects a missing repo', () => {
        const dir = makeTmpDir('env-repo');
        fs.mkdirSync(path.join(dir, 'repos', 'web'), { recursive: true });
        expect(applySetEnv(dir, { key: 'K', value: 'v', target: 'web' })).toEqual({
            ok: true,
            file: 'repos/web/.env',
        });
        expect(applyCheckEnv(dir, { key: 'K', target: 'web' })).toMatchObject({
            ok: true,
            exists: true,
            file: 'repos/web/.env',
        });
        // .env gitignored in the REPO's own .gitignore.
        expect(fs.readFileSync(path.join(dir, 'repos', 'web', '.gitignore'), 'utf8')).toContain('.env');
        // A non-existent repo target is rejected (no stray dir created).
        expect(applySetEnv(dir, { key: 'K', value: 'v', target: 'ghost' }).ok).toBe(false);
        expect(fs.existsSync(path.join(dir, 'repos', 'ghost'))).toBe(false);
    });

    it('rejects an invalid env key', () => {
        const dir = makeTmpDir('env-badkey');
        expect(applySetEnv(dir, { key: '9bad', value: 'x' }).ok).toBe(false);
    });
});

describe('loadWorkspaceEnvVars', () => {
    it('loads the workspace .env as a plain map; empty when absent', () => {
        const dir = makeTmpDir('env-load');
        expect(loadWorkspaceEnvVars(dir)).toEqual({});
        applySetEnv(dir, { key: 'TYNN_AGENT_TOKEN', value: 'rpk_abc.def' });
        applySetEnv(dir, { key: 'PORT', value: '3000' });
        expect(loadWorkspaceEnvVars(dir)).toEqual({ TYNN_AGENT_TOKEN: 'rpk_abc.def', PORT: '3000' });
    });
});

/**
 * Writing the MANAGED SERVICE BLOCK into a repo's `.env` (genie#242).
 *
 * This is the file a Laravel app actually reads, and Genie rewrites it every
 * time a service port moves. It is also a file the user hand-edits. The tests
 * below are the safety contract: their edits survive, a write that changes
 * nothing touches nothing, and a file Genie cannot write fails with a reason
 * instead of an exception.
 */
describe('applyEnvBlock', () => {
    it('creates a gitignored repo .env and writes the managed block', () => {
        const dir = makeTmpDir('env-block-create');
        fs.mkdirSync(path.join(dir, 'repos', 'tynn'), { recursive: true });

        const r = applyEnvBlock(dir, {
            target: 'tynn',
            vars: { DB_PORT: '58377', DB_HOST: '127.0.0.1' },
        });

        expect(r).toMatchObject({ ok: true, changed: true, file: 'repos/tynn/.env' });
        expect(r.keys.sort()).toEqual(['DB_HOST', 'DB_PORT']);
        const content = fs.readFileSync(path.join(dir, 'repos', 'tynn', '.env'), 'utf8');
        expect(content).toContain('DB_PORT=58377');
        expect(fs.readFileSync(path.join(dir, 'repos', 'tynn', '.gitignore'), 'utf8')).toContain('.env');
    });

    it("PRESERVES the user's own file and moves the port they had", () => {
        const dir = makeTmpDir('env-block-preserve');
        const file = path.join(dir, '.env');
        fs.writeFileSync(file, '# mine\nAPP_KEY=base64:xyz\nDB_PORT=51157\n# tail\n');

        applyEnvBlock(dir, { vars: { DB_PORT: '58377' } });

        expect(fs.readFileSync(file, 'utf8')).toBe('# mine\nAPP_KEY=base64:xyz\nDB_PORT=58377\n# tail\n');
    });

    it('a SECOND write with the same values does not touch the file at all', () => {
        const dir = makeTmpDir('env-block-idem');
        const file = path.join(dir, '.env');
        applyEnvBlock(dir, { vars: { DB_PORT: '58377' } });
        const before = fs.readFileSync(file, 'utf8');
        const stat = fs.statSync(file);

        const again = applyEnvBlock(dir, { vars: { DB_PORT: '58377' } });

        expect(again).toMatchObject({ ok: true, changed: false });
        expect(again.keys).toEqual([]);
        expect(fs.readFileSync(file, 'utf8')).toBe(before);
        // Untouched means UNTOUCHED — not rewritten with identical bytes.
        expect(fs.statSync(file).mtimeMs).toBe(stat.mtimeMs);
    });

    it('reports a write failure instead of throwing', () => {
        const dir = makeTmpDir('env-block-readonly');
        // A DIRECTORY where the `.env` should be: unwritable on every platform,
        // unlike a read-only file bit, which Windows administrators bypass.
        fs.mkdirSync(path.join(dir, '.env'));

        const r = applyEnvBlock(dir, { vars: { DB_PORT: '58377' } });

        expect(r.ok).toBe(false);
        expect(r.changed).toBe(false);
        expect(r.error).toMatch(/write failed/i);
    });

    it('refuses a repo that is not there, and creates nothing', () => {
        const dir = makeTmpDir('env-block-ghost');
        const r = applyEnvBlock(dir, { target: 'ghost', vars: { DB_PORT: '1' } });
        expect(r.ok).toBe(false);
        expect(fs.existsSync(path.join(dir, 'repos', 'ghost'))).toBe(false);
    });

    it('drops an invalid key rather than corrupting the file with it', () => {
        const dir = makeTmpDir('env-block-badkey');
        const r = applyEnvBlock(dir, { vars: { '9bad': 'x', GOOD: 'y' } });
        expect(r.ok).toBe(true);
        expect(r.keys).toEqual(['GOOD']);
        expect(fs.readFileSync(path.join(dir, '.env'), 'utf8')).not.toContain('9bad');
    });

    it('writing an empty set is a successful no-op', () => {
        const dir = makeTmpDir('env-block-empty');
        expect(applyEnvBlock(dir, { vars: {} })).toMatchObject({ ok: true, changed: false });
        expect(fs.existsSync(path.join(dir, '.env'))).toBe(false);
    });
});
