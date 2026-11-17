/**
 * RFC 8785 JSON CANONICALIZATION (JCS), for the bytes a Proof-of-Done claim is hashed over (Tynn #740/#742). Tynn hashes its
 * claim this way and the host re-hashes it before signing, so the two must agree on every byte.
 *
 * Object members are ordered by UTF-16 code unit (what `Array.prototype.sort` does to strings), numbers and strings are
 * written as ECMAScript's `JSON.stringify` writes them (which is what RFC 8785 specifies), and there is no whitespace.
 * What JSON has no value for (NaN, Infinity, undefined) is refused rather than guessed at.
 */
export function canonicalize(value: unknown): string {
    if (value === null) return 'null';
    switch (typeof value) {
        case 'boolean': return value ? 'true' : 'false';
        case 'string': return JSON.stringify(value);
        case 'number':
            if (!Number.isFinite(value)) throw new Error('JCS cannot write a number that is not finite');
            // -0 is written 0, as JSON.stringify does.
            return JSON.stringify(value);
        case 'object': {
            if (Array.isArray(value)) return `[${value.map((v) => canonicalize(v)).join(',')}]`;
            const record = value as Record<string, unknown>;
            const keys = Object.keys(record).sort();
            return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(record[k])}`).join(',')}}`;
        }
        default:
            throw new Error(`JCS cannot write a ${typeof value}`);
    }
}
