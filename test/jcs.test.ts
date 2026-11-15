import { describe, expect, it } from 'vitest';
import { canonicalize } from '../src/core/jcs.js';

/** RFC 8785 (JCS): the bytes a Proof-of-Done claim is hashed over, so Tynn and this host must agree on every one. */
describe('canonicalize (RFC 8785)', () => {
    it('sorts keys by UTF-16 code unit, at every depth', () => {
        expect(canonicalize({ b: 1, a: { d: 1, c: 2 } })).toBe('{"a":{"c":2,"d":1},"b":1}');
        // RFC 8785 section 3.2.3: U+20AC (euro) sorts before U+D83D U+DE00 (an emoji), then U+FB33.
        expect(canonicalize({ 'דּ': 3, '\u{1F600}': 2, '€': 1 })).toBe('{"€":1,"\u{1F600}":2,"דּ":3}');
    });

    it('keeps array order and writes no whitespace', () => {
        expect(canonicalize([3, 1, { z: [], a: {} }])).toBe('[3,1,{"a":{},"z":[]}]');
    });

    it('writes numbers as ECMAScript does (RFC 8785 section 3.2.2.3 vectors)', () => {
        expect(canonicalize([333333333.33333329, 1e30, 4.5, 0.002, 1e-7, -0, 0, 1e21])).toBe('[333333333.3333333,1e+30,4.5,0.002,1e-7,0,0,1e+21]');
    });

    it('writes strings with the JSON escapes only', () => {
        expect(canonicalize('a"b/c\n\u0001\u007f')).toBe('"a\\"b/c\\n\\u0001\u007f"');
    });

    it('writes null, true and false, and refuses what JSON has no value for', () => {
        expect(canonicalize({ n: null, t: true, f: false })).toBe('{"f":false,"n":null,"t":true}');
        expect(() => canonicalize(Number.NaN)).toThrow();
        expect(() => canonicalize(Infinity)).toThrow();
        expect(() => canonicalize({ a: undefined })).toThrow();
    });
});
