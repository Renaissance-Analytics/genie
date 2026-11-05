import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// prism-acp 0.36.0's NDJSON reader re-measured and re-searched the whole
// pending line on every chunk, so one long line from an agent (a session
// replay, a large tool result) stalled the main process for seconds and froze
// the window (genie#1568). 0.36.1 reads it in linear time. This reads the
// version actually INSTALLED, so a stale node_modules or lockfile fails here
// too, not only package.json.

const root = join(import.meta.dirname, '..');

function versionOf(raw: string): [number, number, number] {
    const m = /(\d+)\.(\d+)\.(\d+)/.exec(raw);
    if (!m) throw new Error(`not a version: ${raw}`);
    return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function atLeast(v: [number, number, number], min: [number, number, number]): boolean {
    const [a, b, c] = v;
    const [x, y, z] = min;
    if (a !== x) return a > x;
    if (b !== y) return b > y;
    return c >= z;
}

describe('prism-acp is the release whose NDJSON reader does not freeze the window', () => {
    it('the comparison can tell 0.36.0 from 0.36.1 (control)', () => {
        expect(atLeast(versionOf('0.36.0'), [0, 36, 1])).toBe(false);
        expect(atLeast(versionOf('0.36.1'), [0, 36, 1])).toBe(true);
        expect(atLeast(versionOf('0.37.0'), [0, 36, 1])).toBe(true);
    });

    it('the installed prism-acp is 0.36.1 or later', () => {
        const installed = JSON.parse(
            readFileSync(join(root, 'node_modules/@particle-academy/prism-acp/package.json'), 'utf8'),
        ).version as string;
        expect(
            atLeast(versionOf(installed), [0, 36, 1]),
            `installed prism-acp is ${installed}; 0.36.0 froze the window on a long NDJSON line (genie#1568), it must be 0.36.1 or later`,
        ).toBe(true);
    });
});
