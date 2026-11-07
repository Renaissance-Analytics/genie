import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { codeLiteral } from '../scripts/code-literal.mjs';
import { secretNote } from '../scripts/secret-note.mjs';

/*
 * HOW THE SCRIPTS PUT VALUES INTO CODE, AND INTO THEIR LOGS (CodeQL js/bad-code-sanitization and js/clear-text-logging,
 * Tynn #966). A value written into a page's JavaScript goes through codeLiteral, which keeps it a plain string literal
 * whatever it holds. A secret a script reads is reported by secretNote: whether it is there and how long it is, never
 * any of its characters.
 */
const read = (f: string) => readFileSync(f, 'utf8').replace(/\r\n/g, '\n');

describe('codeLiteral: a value written into JavaScript stays one string literal', () => {
    const awkward = ['plain', 'it\'s "quoted"', '</script><script>x()</script>', 'line\u2028sep\u2029para', 'back\\slash', '<!-- -->', ''];

    it('reads back as exactly the value it was given', () => {
        for (const v of awkward) expect(new Function(`return ${codeLiteral(v)};`)(), JSON.stringify(v)).toBe(v);
    });

    it('holds no raw angle bracket or line separator, which a page or a parser could take for something else', () => {
        for (const v of awkward) expect(codeLiteral(v), JSON.stringify(v)).not.toMatch(/[<>\u2028\u2029]/);
    });
});

describe('secretNote: a secret is reported by presence and length only', () => {
    it('says it is there, and how long, with none of its characters', () => {
        const note = secretNote('ghu_0123456789abcdef');
        expect(note).toBe('present, 20 characters');
        expect(note).not.toContain('ghu_');
        expect(note).not.toContain('0123');
    });

    it('says none when there is nothing', () => {
        expect(secretNote(null)).toBe('none');
        expect(secretNote(undefined)).toBe('none');
    });
});

describe('the scripts CodeQL named use them', () => {
    it('site-panel-cdp writes no JSON.stringify straight into page code', () => {
        expect(read('scripts/site-panel-cdp.mjs')).not.toMatch(/evaluate\(`[^`]*\$\{JSON\.stringify\(/);
    });

    it('github-live-cdp prints no part of a token', () => {
        expect(read('scripts/github-live-cdp.mjs')).not.toMatch(/(access|refresh)\.slice\(/);
    });

    it('keychain-measure prints no value read back from the keychain', () => {
        expect(read('scripts/perf-lag/keychain-measure.mjs')).not.toMatch(/String\(\w+\.value\)/);
    });

    it('upgrade-acceptance-cdp keeps the test account off curl\'s command line', () => {
        expect(read('scripts/upgrade-acceptance-cdp.mjs')).not.toMatch(/`email=\$\{ACCOUNT\}`/);
    });
});
