import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * NO PLAIN PROTOCOL TEXT IS WRITTEN TO A RELAY SOCKET (audit M-a, host split P9.2). The two relay ends write frames in
 * exactly two ways: a `control` frame (the grant the relay already has, the proof, the handshake, a renewal, a close),
 * or a frame that went through the session's seal. This reads the two files as code (comments and the insides of strings
 * are taken out first, character by character, so neither can satisfy or trip it) and fails on any other write.
 *
 * - every `encodeFrame(x)`: `x` is `<cipher>.seal(...)`, or an object literal whose `channel` is the literal 'control'
 *   and is written AFTER any spread (so a spread cannot change it);
 * - every `.send(x)` on a socket (`ws`, `socket`): `x` is `encodeFrame(...)`, `encodeMemberHello(...)` (the dial-in), or
 *   `JSON.stringify(hello)` (the host's ticketed hello).
 */
const FILES = ['../src/main/relay-host.ts', '../src/main/relay-member.ts'];

const NEWLINE = '\n';
const BACKSLASH = String.fromCharCode(92);

/** The source with comments blanked (`code`), and with the insides of strings blanked too (`shape`); offsets unchanged. */
function scan(source: string): { code: string; shape: string } {
    const code = source.split('');
    const shape = source.split('');
    const blank = (arr: string[], at: number) => { if (arr[at] !== NEWLINE) arr[at] = ' '; };
    let i = 0;
    while (i < source.length) {
        const c = source[i]!;
        const d = source[i + 1];
        if (c === '/' && d === '/') {
            while (i < source.length && source[i] !== NEWLINE) { blank(code, i); blank(shape, i); i++; }
            continue;
        }
        if (c === '/' && d === '*') {
            const end = source.indexOf('*/', i + 2);
            const stop = end < 0 ? source.length : end + 2;
            for (; i < stop; i++) { blank(code, i); blank(shape, i); }
            continue;
        }
        if (c === "'" || c === '"' || c === '`') {
            i++;
            while (i < source.length && source[i] !== c) {
                if (source[i] === BACKSLASH) { blank(shape, i); i++; }
                blank(shape, i);
                i++;
            }
            i++;
            continue;
        }
        i++;
    }
    return { code: code.join(''), shape: shape.join('') };
}

/** The end (exclusive) of the bracket opened at `open`, in `shape`. */
function closeOf(shape: string, open: number): number {
    let depth = 0;
    for (let i = open; i < shape.length; i++) {
        const c = shape[i];
        if (c === '(' || c === '{' || c === '[') depth++;
        else if (c === ')' || c === '}' || c === ']') { depth--; if (depth === 0) return i + 1; }
    }
    return shape.length;
}

/** The top-level, comma-separated parts between `from` and `to`. */
function parts(shape: string, from: number, to: number): Array<[number, number]> {
    const out: Array<[number, number]> = [];
    let depth = 0;
    let start = from;
    for (let i = from; i < to; i++) {
        const c = shape[i];
        if (c === '(' || c === '{' || c === '[') depth++;
        else if (c === ')' || c === '}' || c === ']') depth--;
        else if (c === ',' && depth === 0) { out.push([start, i]); start = i + 1; }
    }
    if (shape.slice(start, to).trim() !== '') out.push([start, to]);
    return out;
}

export function plainWrites(source: string, file = 'x.ts'): string[] {
    const { code, shape } = scan(source);
    const found: string[] = [];
    const lineOf = (at: number) => `${file}:${source.slice(0, at).split(NEWLINE).length}`;
    /** The inside of the call whose `(` is at `open`: [start, end). */
    const inside = (open: number): [number, number] => [open + 1, closeOf(shape, open) - 1];
    const isSealed = (from: number, to: number): boolean => {
        const m = /^[ \t\r\n]*[A-Za-z0-9_.#]+[.]seal[(]/.exec(shape.slice(from, to));
        return m !== null && shape.slice(closeOf(shape, from + m[0].length - 1), to).trim() === '';
    };
    const isControlLiteral = (from: number, to: number): boolean => {
        const text = shape.slice(from, to);
        const lead = text.length - text.trimStart().length;
        if (text[lead] !== '{' || shape.slice(closeOf(shape, from + lead), to).trim() !== '') return false;
        let channelAt = -1;
        let lastSpread = -1;
        parts(shape, from + lead + 1, closeOf(shape, from + lead) - 1).forEach(([a, b], i) => {
            const prop = shape.slice(a, b).trim();
            if (prop.startsWith('...')) lastSpread = i;
            else if (/^channel[ ]*:/.test(prop)) channelAt = code.slice(a, b).trim().replace(/^channel[ ]*:[ ]*/, '') === "'control'" ? i : -2;
            else if (prop === 'channel') channelAt = -2;
        });
        return channelAt >= 0 && channelAt > lastSpread;
    };
    for (const m of shape.matchAll(/(?<![A-Za-z0-9_.])encodeFrame[(]/g)) {
        const [from, to] = inside(m.index + m[0].length - 1);
        if (!(isSealed(from, to) || isControlLiteral(from, to))) found.push(`${lineOf(m.index)} encodeFrame of a frame that is neither sealed nor a control literal`);
    }
    for (const m of shape.matchAll(/(?<![A-Za-z0-9_.])(?:ws|socket)[.]send[(]/g)) {
        const [from, to] = inside(m.index + m[0].length - 1);
        const arg = shape.slice(from, to).trim();
        const ok = /^(?:encodeFrame|encodeMemberHello)[(]/.test(arg) || arg === 'JSON.stringify(hello)';
        if (!ok) found.push(`${lineOf(m.index)} a socket write that is not an encoded frame or a dial-in hello`);
    }
    return found;
}

describe('the guard itself (it can see what it names)', () => {
    it.each([
        [`ws.send(encodeFrame({ kind: 'data', channel: 'rest', sid, payload: text }));`, 1],
        [`ws.send(encodeFrame({ kind: 'data', channel: 'site', sid, reqId }));`, 1],
        [`ws.send(encodeFrame(frame));`, 1],
        [`ws.send(encodeFrame({ channel: 'control', ...f }));`, 1],
        [`ws.send(encodeFrame({ ...f, channel }));`, 1],
        [`ws.send(encodeFrame({ ...f, channel: kind }));`, 1],
        [`socket.send(text);`, 1],
        // Both a raw write and nothing encoded: one finding (the socket write).
        [`ws.send(JSON.stringify({ kind: 'data', channel: 'rest', sid, payload: text }));`, 1],
    ])('reports %s', (line, count) => {
        expect(plainWrites(line)).toHaveLength(count);
    });

    it.each([
        `ws.send(encodeFrame(session.cipher.seal({ kind: 'data', channel: 'rest', sid, payload: text })));`,
        `ws.send(encodeFrame({ ...f, channel: 'control', sid }));`,
        `ws.send(encodeFrame({ kind: 'data', channel: 'control', sid, payload: { type: 'pop-proof' } }));`,
        `ws.send(encodeMemberHello(id, grant));`,
        `socket.send(JSON.stringify(hello));`,
        `// ws.send(encodeFrame({ kind: 'data', channel: 'rest', sid, payload: text }));`,
        `/* ws.send(encodeFrame(frame)); */`,
        `const s = "ws.send(encodeFrame(frame))";`,
    ])('passes %s', (line) => {
        expect(plainWrites(line)).toEqual([]);
    });
});

describe('the two relay ends', () => {
    it.each(FILES)('%s writes only control frames and sealed frames', (file) => {
        const source = readFileSync(new URL(file, import.meta.url), 'utf8');
        // CONTROL: the file does write frames (so an empty list is not an empty file or a renamed function).
        expect(source.match(/encodeFrame[(]/g)?.length ?? 0).toBeGreaterThan(1);
        expect(plainWrites(source, file)).toEqual([]);
    });

    it.each(FILES)('%s takes its seal from relay-e2e and opens what it reads', (file) => {
        const source = readFileSync(new URL(file, import.meta.url), 'utf8');
        expect(source).toMatch(/from '[.]\/relay-e2e[.]js'/);
        expect(source).toMatch(/[.]open[(]/);
    });
});
