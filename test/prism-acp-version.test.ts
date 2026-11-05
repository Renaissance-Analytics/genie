import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as prism from '@particle-academy/prism-acp';
import { describe, expect, it } from 'vitest';
import { CANCEL_STATE_UNCERTAIN, CANCEL_STATE_UNCERTAIN_CODE } from '../src/core/session.js';

// prism-acp 0.36.0's NDJSON reader re-measured and re-searched the whole
// pending line on every chunk, so one long line from an agent (a session
// replay, a large tool result) stalled the main process for seconds and froze
// the window (genie#1568); 0.36.1 reads it in linear time. 0.37.0's Claude
// cancel sends `cancel_queued: true`, so a prompt taken mid-turn no longer
// runs after Stop (genie#1565). This reads the version actually INSTALLED, so
// a stale node_modules or lockfile fails here too, not only package.json.

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

describe('prism-acp is the release whose Claude Stop drops what was queued mid-turn', () => {
    it('the comparison can tell 0.36.1 from 0.37.0 (control)', () => {
        expect(atLeast(versionOf('0.36.1'), [0, 37, 0])).toBe(false);
        expect(atLeast(versionOf('0.37.0'), [0, 37, 0])).toBe(true);
        expect(atLeast(versionOf('0.38.0'), [0, 37, 0])).toBe(true);
    });

    it('the installed prism-acp is 0.37.0 or later', () => {
        const installed = JSON.parse(
            readFileSync(join(root, 'node_modules/@particle-academy/prism-acp/package.json'), 'utf8'),
        ).version as string;
        expect(
            atLeast(versionOf(installed), [0, 37, 0]),
            `installed prism-acp is ${installed}; before 0.37.0 a prompt Claude took mid-turn ran after Stop (genie#1565), it must be 0.37.0 or later`,
        ).toBe(true);
    });

    it('Genie knows ClaudeCancelStateError by prism-acp’s own fixed reason and code', () => {
        const Ctor = (prism as Record<string, unknown>)['ClaudeCancelStateError'] as (new () => Error & { code: string }) | undefined;
        expect(typeof Ctor, 'prism-acp exports no ClaudeCancelStateError').toBe('function');
        const error = new Ctor!();
        expect(error.message).toBe(CANCEL_STATE_UNCERTAIN);
        expect(error.code).toBe(CANCEL_STATE_UNCERTAIN_CODE);
    });
});
