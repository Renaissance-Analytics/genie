import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { dotEnvServiceVars, MANAGED_ENV_HEADER, parseDotEnv, upsertDotEnv } from '../src/core/dotenv.js';
import { DotEnvSync, gitIgnoredOver, type GitIgnoreAnswer } from '../src/main/dotenv-sync.js';
import { nodeEnvelopeFs } from '../src/main/envelope-sites-host.js';

/**
 * THE WORKSPACE'S SERVICE CONNECTION IN ITS APP'S `.env` (hosting ship line H4) — Genie 1's env-sync (genie#242),
 * ported. Genie handed the connection to the processes it started and nowhere else, so an app run from an editor or a
 * shell Genie did not open read a `.env` that said whatever it said the day someone typed it. Now each site repo's
 * `.env` carries it, key by key, kept current — and NEVER into a file git would commit.
 */

const ENV = {
    DATABASE_URL: 'postgresql://ws_example_a:genpw-0002@127.0.0.1:4101/ws_example_a',
    DB_CONNECTION: 'pgsql', DB_HOST: '127.0.0.1', DB_PORT: '4101', DB_DATABASE: 'ws_example_a', DB_USERNAME: 'ws_example_a', DB_PASSWORD: 'genpw-0002',
    PGHOST: '127.0.0.1', PGPORT: '4101', PGUSER: 'ws_example_a', PGPASSWORD: 'genpw-0002', PGDATABASE: 'ws_example_a',
};

describe('which keys', () => {
    it('the app’s own config, not the client-tool duplicates (PG*, MYSQL_*) — counted against the input', () => {
        const vars = dotEnvServiceVars(ENV);
        expect(Object.keys(vars).sort()).toEqual(['DATABASE_URL', 'DB_CONNECTION', 'DB_DATABASE', 'DB_HOST', 'DB_PASSWORD', 'DB_PORT', 'DB_USERNAME']);
        expect(Object.keys(ENV).length - Object.keys(vars).length).toBe(5);
    });
});

describe('the upsert — everything that is not Genie’s is carried through byte for byte', () => {
    const LARAVEL = [
        '# The app',
        'APP_NAME=Example',
        'APP_KEY=base64:abc=',
        '',
        '# Database — the person’s note stays',
        'DB_CONNECTION=sqlite',
        'DB_PORT=3306 # old port',
        'MAIL_FROM_ADDRESS="hello@example.com"',
        '',
    ].join('\n');

    it('a key already in the file is rewritten IN PLACE; new keys join ONE block under Genie’s marker; comments, blank lines and the person’s keys are untouched', () => {
        const out = upsertDotEnv(LARAVEL, dotEnvServiceVars(ENV));
        const lines = out.split('\n');
        expect(lines.slice(0, 5)).toEqual(['# The app', 'APP_NAME=Example', 'APP_KEY=base64:abc=', '', '# Database — the person’s note stays']);
        expect(lines[5]).toBe('DB_CONNECTION=pgsql');
        expect(lines[6]).toBe('DB_PORT=4101');
        expect(lines[7]).toBe('MAIL_FROM_ADDRESS="hello@example.com"');
        expect(lines.indexOf(MANAGED_ENV_HEADER)).toBeGreaterThan(7);
        expect(lines.slice(lines.indexOf(MANAGED_ENV_HEADER) + 1).filter((l) => l !== '').map((l) => l.split('=')[0]).sort()).toEqual(['DATABASE_URL', 'DB_DATABASE', 'DB_HOST', 'DB_PASSWORD', 'DB_USERNAME']);
        // Every line that was there and is not a managed key is still there, verbatim.
        const managed = new Set(Object.keys(dotEnvServiceVars(ENV)));
        for (const l of LARAVEL.split('\n')) if (!managed.has(l.split('=')[0]!)) expect(lines).toContain(l);
        expect(parseDotEnv(out).get('DB_PASSWORD')).toBe('genpw-0002');
        expect(parseDotEnv(out).get('APP_KEY')).toBe('base64:abc=');
    });

    it('idempotent: run again on its own output, the text is IDENTICAL (no write follows)', () => {
        const once = upsertDotEnv(LARAVEL, dotEnvServiceVars(ENV));
        expect(upsertDotEnv(once, dotEnvServiceVars(ENV))).toBe(once);
    });

    it('a port that moves is rewritten where it is — the block does not grow a second copy', () => {
        const once = upsertDotEnv(LARAVEL, dotEnvServiceVars(ENV));
        const moved = upsertDotEnv(once, dotEnvServiceVars({ ...ENV, DB_PORT: '4207', DATABASE_URL: ENV.DATABASE_URL.replace('4101', '4207') }));
        expect(moved.split('\n').filter((l) => l.startsWith('DB_PORT='))).toEqual(['DB_PORT=4207']);
        expect(moved.split('\n').filter((l) => l.startsWith('DATABASE_URL='))).toHaveLength(1);
        expect(moved.split('\n').length).toBe(once.split('\n').length);
    });

    it('CRLF files stay CRLF — every line, including the ones Genie adds; an empty file starts with the marker', () => {
        const crlf = 'APP_NAME=Example\r\nDB_PORT=1\r\n';
        const out = upsertDotEnv(crlf, { DB_PORT: '4101', DB_HOST: '127.0.0.1' });
        expect(out).toBe(`APP_NAME=Example\r\nDB_PORT=4101\r\n\r\n${MANAGED_ENV_HEADER}\r\nDB_HOST=127.0.0.1\r\n`);
        expect(upsertDotEnv('', { DB_HOST: '127.0.0.1' })).toBe(`${MANAGED_ENV_HEADER}\nDB_HOST=127.0.0.1\n`);
    });
});

describe('the sync — real files in a temp folder, git’s answer faked', () => {
    let root: string;
    let repo: string;
    let env: Record<string, string>;
    let answer: GitIgnoreAnswer;
    let asked: number;
    let sync: DotEnvSync;

    beforeEach(async () => {
        root = await mkdtemp(join(tmpdir(), 'genie2-dotenv-'));
        repo = join(root, 'repos', 'web');
        await mkdir(repo, { recursive: true });
        env = { ...ENV };
        answer = 'ignored';
        asked = 0;
        sync = new DotEnvSync({
            envFor: (ws) => (ws === 'example-a' ? env : {}),
            sites: () => [{ workspaceId: 'example-a', repoPath: repo }, { workspaceId: 'example-a', repoPath: repo }, { workspaceId: 'example-b', repoPath: join(root, 'other') }],
            fs: nodeEnvelopeFs(),
            gitIgnored: async () => { asked++; return answer; },
        });
    });

    afterEach(async () => {
        await rm(root, { recursive: true, force: true });
    });

    it('writes the site repo’s `.env` — once for two sites in one folder — preserving what was there', async () => {
        await writeFile(join(repo, '.env'), '# mine\nAPP_NAME=Example\n', 'utf8');
        const out = await sync.syncAll();
        expect(out).toEqual([{ workspaceId: 'example-a', file: join(repo, '.env'), outcome: 'written', keys: Object.keys(dotEnvServiceVars(ENV)) }]);
        const text = await readFile(join(repo, '.env'), 'utf8');
        expect(text.startsWith('# mine\nAPP_NAME=Example\n')).toBe(true);
        expect(parseDotEnv(text).get('DB_PORT')).toBe('4101');
        expect(text).not.toContain('PGPASSWORD');
    });

    it('a workspace with no service env gets nothing written — no file is created (control: the one with env is written; git asked for it alone)', async () => {
        const out = await sync.syncAll();
        expect(out.map((o) => o.workspaceId)).toEqual(['example-a']);
        expect(asked).toBe(1);
        await expect(readFile(join(root, 'other', '.env'), 'utf8')).rejects.toThrow();
    });

    it('rewritten when the port changes; a pass that finds it current writes nothing and does not ask git', async () => {
        await sync.syncAll();
        expect(asked).toBe(1);
        expect((await sync.syncAll())[0]).toMatchObject({ outcome: 'current' });
        expect(asked).toBe(1);
        env = { ...ENV, DB_PORT: '4207' };
        expect((await sync.syncAll())[0]).toMatchObject({ outcome: 'written', keys: ['DB_PORT'] });
        expect(parseDotEnv(await readFile(join(repo, '.env'), 'utf8')).get('DB_PORT')).toBe('4207');
    });

    it('REFUSES when git does not ignore the `.env` (or tracks it): the file is byte-identical after, and the refusal says how to fix it. Control: the same file, ignored, is written', async () => {
        const before = '# mine\r\nDB_PORT=3306\r\n';
        await writeFile(join(repo, '.env'), before, 'utf8');
        answer = 'not-ignored';
        const [refused] = await sync.syncAll();
        expect(refused).toMatchObject({ outcome: 'refused' });
        expect((refused as { reason: string }).reason).toMatch(/NOT written: git does not ignore it.*\.gitignore/);
        expect(await readFile(join(repo, '.env'), 'utf8')).toBe(before);
        expect(sync.outcomes()).toEqual([refused]);

        answer = 'no-repo';
        expect((await sync.syncAll())[0]).toMatchObject({ outcome: 'refused' });
        expect(await readFile(join(repo, '.env'), 'utf8')).toBe(before);

        answer = 'ignored';
        expect((await sync.syncAll())[0]).toMatchObject({ outcome: 'written' });
        expect(parseDotEnv(await readFile(join(repo, '.env'), 'utf8')).get('DB_PORT')).toBe('4101');
    });

    it('a burst of asks shares ONE pass — git asked once, not three times', async () => {
        const [a, b, c] = [sync.syncAll(), sync.syncAll(), sync.syncAll()];
        expect(a).toBe(b);
        expect(b).toBe(c);
        await Promise.all([a, b, c]);
        expect(asked).toBe(1);
    });
});

describe('git’s answer', () => {
    it('`git check-ignore -q -- .env` in the folder: 0 ignored, 1 not ignored, anything else (128: no repository) is not "ignored"', async () => {
        const seen: { args: readonly string[]; cwd?: string }[] = [];
        const exitFor = (code: number) => gitIgnoredOver(async (_bin, args, options) => { seen.push({ args, ...(options?.cwd !== undefined ? { cwd: options.cwd } : {}) }); return { stdout: '', exitCode: code }; });
        expect(await exitFor(0)('/work/example', '.env')).toBe('ignored');
        expect(await exitFor(1)('/work/example', '.env')).toBe('not-ignored');
        expect(await exitFor(128)('/work/example', '.env')).toBe('no-repo');
        expect(await gitIgnoredOver(async () => { throw Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' }); })('/work/example', '.env')).toBe('no-repo');
        expect(seen[0]).toEqual({ args: ['check-ignore', '-q', '--', '.env'], cwd: '/work/example' });
    });
});
