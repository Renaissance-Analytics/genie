import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
    compareTrackBuilds, negotiate, offerOf, parseTrackBuild, SECURITY_FLOOR_SCHEMA, SUPPORT_WINDOW_DAYS, windowFloor,
    type ProtocolOffer,
} from '../src/core/protocol-version.js';
import { semverOf } from '../src/core/track-manifest.js';

/*
 * THE SHARED VERSION-NEGOTIATION TABLE (Tynn #1058 L1). test/fixtures/protocol-negotiation.json holds pairs of offers
 * and the answer each side reaches, the window floors, and how track builds parse and order. The Rust launcher's
 * `cargo test` (L2) reads the same file, so `negotiate`, `windowFloor` and the build order written again in Rust cannot
 * drift from these. Every row here is a skew outcome the two languages must agree on.
 */

type Answer =
    | { ok: true; negotiated: { schema: string; capabilities: string[] } }
    | { ok: false; code: 'version'; peerTooOld: boolean };
interface Table {
    format: number;
    supportWindowDays: number;
    securityFloor: string;
    windowFloor: Array<{ schema: string; floor: string }>;
    cases: Array<{ name: string; mine: ProtocolOffer; theirs: ProtocolOffer; answer: Answer }>;
    trackBuilds: Array<{ build: string; parsed: { schema: string; release: number; hotfix: number } | null; semver: string | null }>;
    buildOrder: Array<{ a: string; b: string; sign: -1 | 0 | 1 }>;
}

const table = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'protocol-negotiation.json'), 'utf8')) as Table;

/** negotiate's answer without its prose: what the table compares. */
function answerOf(mine: ProtocolOffer, theirs: ProtocolOffer): Answer {
    const n = negotiate(mine, theirs);
    return n.ok
        ? { ok: true, negotiated: { schema: n.negotiated.schema, capabilities: [...n.negotiated.capabilities] } }
        : { ok: false, code: n.code, peerTooOld: n.peerTooOld };
}

describe('the shared negotiation table', () => {
    it('is format 1 and states the constants the code uses', () => {
        expect(table.format).toBe(1);
        expect(table.supportWindowDays).toBe(SUPPORT_WINDOW_DAYS);
        expect(table.securityFloor).toBe(SECURITY_FLOOR_SCHEMA);
    });

    it.each(table.windowFloor)('the window floor of $schema is $floor', ({ schema, floor }) => {
        expect(windowFloor(schema)).toBe(floor);
    });

    it('names every case once', () => {
        expect(new Set(table.cases.map((c) => c.name)).size).toBe(table.cases.length);
    });

    it('has every outcome: agreed, the peer too old, and this side too old, with the floor itself accepted', () => {
        expect(table.cases.some((c) => c.answer.ok)).toBe(true);
        expect(table.cases.some((c) => !c.answer.ok && c.answer.peerTooOld)).toBe(true);
        expect(table.cases.some((c) => !c.answer.ok && !c.answer.peerTooOld)).toBe(true);
        expect(table.cases.some((c) => c.answer.ok && c.theirs.schema === c.mine.minSchema)).toBe(true);
        expect(table.cases.some((c) => c.theirs.track === null)).toBe(true);
    });

    describe.each(table.cases)('$name', ({ mine, theirs, answer }) => {
        it('holds offers as they are read off the wire', () => {
            expect(offerOf(mine)).toEqual(mine);
            expect(offerOf(theirs)).toEqual(theirs);
        });

        it('is the answer negotiate gives', () => {
            expect(answerOf(mine, theirs)).toEqual(answer);
        });

        it('is the mirror of the other side\'s answer (the pair agrees without a third message)', () => {
            const other = answerOf(theirs, mine);
            if (answer.ok) expect(other).toEqual(answer);
            else expect(other).toEqual({ ok: false, code: 'version', peerTooOld: !answer.peerTooOld });
        });
    });

    it.each(table.trackBuilds)('the track build $build parses to $parsed, semver $semver', ({ build, parsed, semver }) => {
        expect(parseTrackBuild(build)).toEqual(parsed);
        expect(semverOf(build)).toBe(semver);
    });

    it.each(table.buildOrder)('$a against $b orders $sign', ({ a, b, sign }) => {
        expect(Math.sign(compareTrackBuilds(a, b)) || 0).toBe(sign);
        expect(Math.sign(compareTrackBuilds(b, a)) || 0).toBe(sign === 0 ? 0 : -sign);
    });
});
