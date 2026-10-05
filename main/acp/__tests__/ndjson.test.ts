import { describe, expect, it } from 'vitest';
import { NdjsonReader, encodeNdjson } from '../ndjson';

/**
 * The framing under ACP: newline-delimited JSON on a child's stdout.
 *
 * Every assertion here is about a boundary a stream does not respect. A pipe delivers
 * whatever arrived, so a message can be split anywhere — mid-object, mid-string,
 * mid-escape — and two messages can arrive glued together. Getting this wrong does not
 * throw; it silently drops an agent's turn, and "the agent went quiet" is
 * indistinguishable from the agent actually being quiet.
 */

const collect = () => {
    const seen: unknown[] = [];
    const errors: string[] = [];
    const r = new NdjsonReader(
        (v) => seen.push(v),
        (e) => errors.push(e),
    );
    return { r, seen, errors };
};

describe('NdjsonReader', () => {
    it('reads one whole line', () => {
        const { r, seen } = collect();
        r.push('{"a":1}\n');
        expect(seen).toEqual([{ a: 1 }]);
    });

    it('reads several lines in one chunk', () => {
        const { r, seen } = collect();
        r.push('{"a":1}\n{"a":2}\n');
        expect(seen).toEqual([{ a: 1 }, { a: 2 }]);
    });

    it('waits for a line split across chunks', () => {
        // The case that matters most: a pipe can split anywhere.
        const { r, seen } = collect();
        r.push('{"a":');
        expect(seen).toEqual([]);
        r.push('1}\n');
        expect(seen).toEqual([{ a: 1 }]);
    });

    it('waits when the split lands INSIDE a string', () => {
        const { r, seen } = collect();
        r.push('{"t":"hel');
        r.push('lo"}\n');
        expect(seen).toEqual([{ t: 'hello' }]);
    });

    it('waits when the split lands inside an escape sequence', () => {
        // The chunk boundary falls between the backslash and the `n` of an escaped
        // newline. A reader that tried to interpret anything before a complete line
        // would mangle it.
        const { r, seen } = collect();
        r.push('{"t":"a' + String.fromCharCode(92));
        r.push('nb"}\n');
        expect(seen).toEqual([{ t: 'a\nb' }]);
    });

    it('does NOT treat an escaped newline inside a string as a frame boundary', () => {
        // On the wire an escaped newline is the two characters `\` and `n`, so it
        // cannot be mistaken for a terminator. That is exactly why splitting on a real
        // newline is correct.
        const { r, seen } = collect();
        r.push('{"t":"a' + String.fromCharCode(92) + 'nb"}\n');
        expect(seen).toEqual([{ t: 'a\nb' }]);
    });

    it('holds a trailing partial line until its newline arrives', () => {
        const { r, seen } = collect();
        r.push('{"a":1}\n{"a":2');
        expect(seen).toEqual([{ a: 1 }]);
        r.push('}\n');
        expect(seen).toEqual([{ a: 1 }, { a: 2 }]);
    });

    it('ignores blank lines rather than reporting them as errors', () => {
        // Agents pad. A blank line is not a malformed message.
        const { r, seen, errors } = collect();
        r.push('\n\n{"a":1}\n\n');
        expect(seen).toEqual([{ a: 1 }]);
        expect(errors).toEqual([]);
    });

    it('survives CRLF, because one end of this may be Windows', () => {
        const { r, seen, errors } = collect();
        r.push('{"a":1}\r\n{"a":2}\r\n');
        expect(seen).toEqual([{ a: 1 }, { a: 2 }]);
        expect(errors).toEqual([]);
    });

    it('strips the carriage return from what it REPORTS, which is the part that needs it', () => {
        // The honest scope of the trim. Removing it leaves every other test green,
        // because `JSON.parse` accepts a trailing carriage return as whitespace —
        // measured directly. What it does change is the error text for a bad frame on
        // a CRLF stream, which would otherwise carry an invisible stray character into
        // a log somebody has to read.
        const { r, errors } = collect();
        r.push('not json\r\n');
        expect(errors).toHaveLength(1);
        expect(errors[0]).toContain('not json');
        expect(errors[0]).not.toContain('\r');
    });

    it('reports a malformed line and KEEPS READING', () => {
        // One bad frame must not end the session. The agent is still running and its
        // next message is still coming.
        const { r, seen, errors } = collect();
        r.push('not json\n{"a":1}\n');
        expect(seen).toEqual([{ a: 1 }]);
        expect(errors).toHaveLength(1);
        expect(errors[0]).toContain('not json');
    });

    it('does not lose the rest of a chunk after a malformed line', () => {
        const { r, seen } = collect();
        r.push('{"a":1}\nbroken\n{"a":2}\n');
        expect(seen).toEqual([{ a: 1 }, { a: 2 }]);
    });

    it('refuses to grow without bound on a stream that never sends a newline', () => {
        // A wedged or hostile child could otherwise hold the whole heap.
        const { r, seen, errors } = collect();
        r.push('x'.repeat(2_000_000));
        expect(seen).toEqual([]);
        expect(errors.some((e) => /too long|overflow/i.test(e))).toBe(true);
        // And it recovers: the next complete line still reads.
        r.push('\n{"a":1}\n');
        expect(seen).toEqual([{ a: 1 }]);
    });

    it('does not report the dropped content, only its size', () => {
        // It could be megabytes, and it could be a credential if the child is confused
        // about what it is writing. The error says how much, not what.
        const { r, errors } = collect();
        r.push('SECRET'.repeat(200_000));
        expect(errors).toHaveLength(1);
        expect(errors[0]).not.toContain('SECRET');
        expect(errors[0]).toMatch(/\d+ bytes/);
    });
});

describe('encodeNdjson', () => {
    it('appends exactly one newline', () => {
        expect(encodeNdjson({ a: 1 })).toBe('{"a":1}\n');
    });

    it('escapes a newline inside a value rather than emitting it raw', () => {
        // Emitting it raw would split one message into two frames and make the second
        // unparseable — a self-inflicted version of the malformed-line case above.
        const out = encodeNdjson({ t: 'a\nb' });
        expect(out.endsWith('\n')).toBe(true);
        expect(out.slice(0, -1)).not.toContain('\n');
    });
});
