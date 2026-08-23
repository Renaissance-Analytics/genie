import { describe, it, expect } from 'vitest';
import {
    parseEnv,
    upsertEnvLine,
    upsertEnvBlock,
    isValidEnvKey,
    isSecretKey,
    isSecretValue,
    isSecret,
    obfuscateSecret,
} from '../env-file';

describe('parseEnv', () => {
    it('parses KEY=value, skipping blanks + comments, honouring export + quotes', () => {
        const m = parseEnv(
            [
                '# a comment',
                '',
                'FOO=bar',
                'export TOKEN=rpk_123',
                'QUOTED="has spaces"',
                "SINGLE='x y'",
                'INLINE=plain # trailing comment',
                'NOEQ',
                '=novalue',
            ].join('\n'),
        );
        expect(m.get('FOO')).toBe('bar');
        expect(m.get('TOKEN')).toBe('rpk_123');
        expect(m.get('QUOTED')).toBe('has spaces');
        expect(m.get('SINGLE')).toBe('x y');
        expect(m.get('INLINE')).toBe('plain');
        expect(m.has('NOEQ')).toBe(false);
        expect(m.size).toBe(5);
    });

    it('later duplicate keys win', () => {
        expect(parseEnv('K=1\nK=2').get('K')).toBe('2');
    });
});

describe('upsertEnvLine', () => {
    it('appends a new key, preserving existing content', () => {
        expect(upsertEnvLine('FOO=bar\n', 'BAZ', 'qux')).toBe('FOO=bar\nBAZ=qux\n');
    });

    it('replaces an existing key IN PLACE (keeping comments + siblings + order)', () => {
        const next = upsertEnvLine('# c\nFOO=old\nBAR=keep\n', 'FOO', 'new');
        expect(next).toBe('# c\nFOO=new\nBAR=keep\n');
    });

    it('replaces an `export `-prefixed key', () => {
        expect(upsertEnvLine('export TOKEN=old\n', 'TOKEN', 'new')).toBe('TOKEN=new\n');
    });

    it('quotes values that need it; leaves tokens raw', () => {
        expect(upsertEnvLine('', 'TOKEN', 'rpk_abc.def')).toBe('TOKEN=rpk_abc.def\n');
        expect(upsertEnvLine('', 'MSG', 'a b')).toBe('MSG="a b"\n');
        expect(upsertEnvLine('', 'EMPTY', '')).toBe('EMPTY=""\n');
    });

    it('round-trips through parseEnv', () => {
        const content = upsertEnvLine(upsertEnvLine('', 'A', 'b c'), 'TOKEN', 'rpk_x');
        const m = parseEnv(content);
        expect(m.get('A')).toBe('b c');
        expect(m.get('TOKEN')).toBe('rpk_x');
    });
});

describe('isValidEnvKey', () => {
    it('accepts shell-style names, rejects others', () => {
        expect(isValidEnvKey('TYNN_AGENT_TOKEN')).toBe(true);
        expect(isValidEnvKey('_x9')).toBe(true);
        expect(isValidEnvKey('9LEADING')).toBe(false);
        expect(isValidEnvKey('has-dash')).toBe(false);
        expect(isValidEnvKey('has space')).toBe(false);
        expect(isValidEnvKey('')).toBe(false);
    });
});

describe('secret detection', () => {
    it('flags secret-y KEY names (case-insensitive)', () => {
        for (const k of ['TYNN_AGENT_TOKEN', 'API_KEY', 'db_password', 'MY_SECRET', 'STRIPE_KEY', 'X_PWD'])
            expect(isSecretKey(k)).toBe(true);
    });
    it('does NOT flag plain config keys', () => {
        for (const k of ['PORT', 'NODE_ENV', 'BASE_URL', 'TIMEOUT'])
            expect(isSecretKey(k)).toBe(false);
    });
    it('flags secret-shaped VALUES under innocuous keys', () => {
        expect(isSecretValue('rpk_abc.def_longtail000000')).toBe(true);
        expect(isSecretValue('ghp_0123456789abcdef0123456789abcdef0123')).toBe(true);
        expect(isSecretValue('aaaa.bbbbbbbb.cccccccc'.replace(/\./g, 'x') + '.y.z')).toBe(false); // not a clean JWT
        expect(isSecretValue('eyJhbGciOi.eyJzdWIiOi.s3cr3tSignature')).toBe(true); // JWT-ish
        expect(isSecretValue('http://localhost:3000')).toBe(false);
        expect(isSecretValue('plain')).toBe(false);
    });
    it('isSecret = key OR value', () => {
        expect(isSecret('NICKNAME', 'rpk_abcdef')).toBe(true); // value
        expect(isSecret('GH_TOKEN', 'short')).toBe(true); // key
        expect(isSecret('PORT', '3000')).toBe(false);
    });
});

describe('obfuscateSecret', () => {
    it('reveals only the last 4 chars behind a dotted prefix', () => {
        expect(obfuscateSecret('rpk_abcdef3f2a')).toBe('••••••3f2a');
        expect(obfuscateSecret('abcd')).toBe('••••••abcd');
    });
});

/**
 * The MANAGED BLOCK writer (genie#242).
 *
 * Genie now writes a workspace's service connection into the repo's own `.env`,
 * which is the file the application actually reads. That file belongs to the
 * USER — hand-edited, commented, ordered the way they left it — so the writer is
 * a read-modify-write that may only touch the keys it manages, and must be a
 * true no-op when nothing has moved (a `.env` that churns on every service tick
 * is a `.env` nobody will trust to hold their own edits).
 */
const HEADER = '# --- Genie: managed service connection (genie#242) ---';

describe('upsertEnvBlock', () => {
    it('leaves a hand-edited file otherwise INTACT — comments, order, trailing content', () => {
        const before = [
            '# My app',
            'APP_NAME=Tynn',
            '',
            '# database',
            'DB_CONNECTION=pgsql',
            'DB_PORT=51157',
            '',
            '# a trailing note the user wrote',
            'MAIL_FROM=me@example.com',
            '',
        ].join('\n');

        const after = upsertEnvBlock(before, { DB_PORT: '58377' }, HEADER);

        expect(after).toBe(
            [
                '# My app',
                'APP_NAME=Tynn',
                '',
                '# database',
                'DB_CONNECTION=pgsql',
                'DB_PORT=58377',
                '',
                '# a trailing note the user wrote',
                'MAIL_FROM=me@example.com',
                '',
            ].join('\n'),
        );
    });

    it('updates a MOVED port in place — never appends a second DB_PORT', () => {
        const after = upsertEnvBlock('DB_PORT=51157\n', { DB_PORT: '58377' }, HEADER);
        expect(after).toBe('DB_PORT=58377\n');
        expect(after.match(/^DB_PORT=/gm)).toHaveLength(1);
    });

    it('is IDEMPOTENT — a second write with the same values changes nothing', () => {
        const first = upsertEnvBlock('APP_NAME=Tynn\n', { DB_PORT: '58377' }, HEADER);
        const second = upsertEnvBlock(first, { DB_PORT: '58377' }, HEADER);
        expect(second).toBe(first);
        // And a third, so "stable" is not an accident of the first append.
        expect(upsertEnvBlock(second, { DB_PORT: '58377' }, HEADER)).toBe(first);
    });

    it('returns the content byte-identical when EVERY value already agrees', () => {
        // Not merely equivalent: the SAME string. A file whose line endings or
        // quoting Genie would have written differently must not be rewritten for
        // that reason alone — the user owns those bytes.
        const crlf = '# note\r\nAPP_NAME=Tynn\r\nDB_PORT=58377\r\n';
        expect(upsertEnvBlock(crlf, { DB_PORT: '58377' }, HEADER)).toBe(crlf);
    });

    it('appends NEW keys under a marked header', () => {
        const after = upsertEnvBlock('APP_NAME=Tynn\n', { DB_PORT: '58377', DB_HOST: '127.0.0.1' }, HEADER);
        expect(after).toContain(HEADER);
        expect(after.indexOf(HEADER)).toBeGreaterThan(after.indexOf('APP_NAME'));
        expect(after).toContain('DB_PORT=58377');
        expect(after).toContain('DB_HOST=127.0.0.1');
        expect(after.startsWith('APP_NAME=Tynn\n')).toBe(true);
    });

    it('grows the EXISTING block rather than writing a second header', () => {
        const first = upsertEnvBlock('APP_NAME=Tynn\n', { DB_PORT: '58377' }, HEADER);
        const second = upsertEnvBlock(first, { DB_PORT: '58377', REDIS_PORT: '51032' }, HEADER);
        expect(second.match(/Genie: managed service connection/g)).toHaveLength(1);
        expect(second).toContain('REDIS_PORT=51032');
        // The block stays contiguous: the new key sits with the old one.
        const lines = second.split('\n');
        const at = lines.indexOf(HEADER);
        expect(lines.slice(at + 1, at + 3).sort()).toEqual(['DB_PORT=58377', 'REDIS_PORT=51032']);
    });

    it('writes into an EMPTY file without a leading blank line', () => {
        expect(upsertEnvBlock('', { DB_PORT: '58377' }, HEADER)).toBe(`${HEADER}\nDB_PORT=58377\n`);
    });

    it('respects a key the user moved OUT of the block and edited', () => {
        // The user pulled DB_PORT up to the top of their file. The next write must
        // follow it there, not resurrect a copy inside the managed block.
        const moved = ['DB_PORT=51157', '', HEADER, 'DB_HOST=127.0.0.1', ''].join('\n');
        const after = upsertEnvBlock(moved, { DB_PORT: '58377', DB_HOST: '127.0.0.1' }, HEADER);
        expect(after.split('\n')[0]).toBe('DB_PORT=58377');
        expect(after.match(/^DB_PORT=/gm)).toHaveLength(1);
    });

    it('quotes a value that needs it, and finds an `export `-prefixed key', () => {
        expect(upsertEnvBlock('export DB_PASSWORD=old\n', { DB_PASSWORD: 'a b' }, HEADER)).toBe(
            'DB_PASSWORD="a b"\n',
        );
    });

    it('writing NOTHING is a no-op', () => {
        expect(upsertEnvBlock('APP_NAME=Tynn\n', {}, HEADER)).toBe('APP_NAME=Tynn\n');
    });
});

/**
 * ADVERSARIAL. The writer runs UNATTENDED, on a service lifecycle tick, against a
 * file the user owns and hand-edits. "Preserves their content" has to hold for the
 * files people actually have — not only the tidy LF one with each key written once.
 *
 * Each case below is a way the previous writer silently damaged or defeated itself.
 */
describe('upsertEnvBlock — never harms the file, even an awkward one', () => {
    it('keeps CRLF endings when a value ACTUALLY CHANGES', () => {
        // The no-change case was already covered. The change case reflowed the
        // WHOLE file to LF: on Windows that is every line of the user's `.env`
        // showing up as a diff because one port moved.
        const crlf = '# note\r\nAPP_NAME=Tynn\r\nDB_PORT=51157\r\n';
        const after = upsertEnvBlock(crlf, { DB_PORT: '58377' }, HEADER);
        expect(after).toBe('# note\r\nAPP_NAME=Tynn\r\nDB_PORT=58377\r\n');
    });

    it('appends a NEW key using the file’s own CRLF endings', () => {
        const after = upsertEnvBlock('APP_NAME=Tynn\r\n', { DB_HOST: '127.0.0.1' }, HEADER);
        // No bare LF anywhere: a mixed-ending .env is a file some tools misread.
        expect(after.replace(/\r\n/g, '')).not.toContain('\n');
        expect(after).toContain('DB_HOST=127.0.0.1');
        expect(after.startsWith('APP_NAME=Tynn\r\n')).toBe(true);
    });

    it('rewrites the EFFECTIVE duplicate — the last one, which is what dotenv reads', () => {
        // A hand-edited file with the key twice. parseEnv, dotenv, and a shell all
        // take the LAST assignment. Rewriting the FIRST leaves the app reading the
        // stale second one — precisely the stale-port bug this feature exists to end,
        // reintroduced by the fix for it.
        const before = 'DB_PORT=51157\nOTHER=x\nDB_PORT=51157\n';
        const after = upsertEnvBlock(before, { DB_PORT: '58377' }, HEADER);
        expect(parseEnv(after).get('DB_PORT')).toBe('58377');
    });

    it('never DELETES a duplicate line the user wrote', () => {
        // Making the write effective must not become a licence to prune their file.
        const after = upsertEnvBlock('DB_PORT=51157\nDB_PORT=51157\n', { DB_PORT: '58377' }, HEADER);
        expect(after.match(/^DB_PORT=/gm)).toHaveLength(2);
    });

    it('IGNORES a key that is not a legal env name instead of matching it as a regex', () => {
        // The key was interpolated straight into a RegExp. `DB.*` matched the line
        // `DB_PORT=1` and overwrote it — silent corruption of an unrelated key.
        const before = 'DB_PORT=51157\n';
        expect(upsertEnvBlock(before, { 'DB.*': 'x' }, HEADER)).toBe(before);
    });

    it('preserves a file that ends WITHOUT a trailing newline', () => {
        expect(upsertEnvBlock('DB_PORT=51157', { DB_PORT: '58377' }, HEADER)).toBe('DB_PORT=58377');
    });

    it('leaves a COMMENTED-OUT key commented out, and writes the real one', () => {
        const after = upsertEnvBlock('# DB_PORT=51157\nDB_PORT=51157\n', { DB_PORT: '58377' }, HEADER);
        expect(after).toContain('# DB_PORT=51157');
        expect(parseEnv(after).get('DB_PORT')).toBe('58377');
    });
});
