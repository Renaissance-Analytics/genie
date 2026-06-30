import { describe, it, expect } from 'vitest';
import {
    parseEnv,
    upsertEnvLine,
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
