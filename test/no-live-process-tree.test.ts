import { describe, expect, it } from 'vitest';

/**
 * NO TEST MAY TOUCH THE REAL PROCESS TREE.
 *
 * `AgentSession` and `SessionHost` both fall back to `systemProcessTree` when none is injected.
 * On Windows that shells out to PowerShell to enumerate descendants, and then **kills** every
 * pid that appeared between start and stop. In a runner with parallel workers, those pids can
 * belong to a sibling worker.
 *
 * It was happening. `test/session.test.ts` took **25.8 seconds for 21 tests that do no I/O**,
 * and it surfaced as an intermittent failure in a different file — a flaky `stopAll` assertion
 * at 6.5 seconds for a test that does nothing slow. The duration was the tell.
 *
 * With the tree injected the whole suite runs in **1.7 seconds** instead of 28.
 *
 * ## Why a source scan rather than a type
 *
 * Making `processTree` required would force production code to pass the real one explicitly,
 * which is worse: the fallback is CORRECT for the app and wrong only for tests. So the rule is
 * "tests must inject", and that is a property of the test files themselves.
 *
 * The same shape as `test/icons.test.ts`'s scan, and for the same reason: a list that only has
 * to agree with itself drifts silently.
 */

describe('every session a TEST starts uses an injected process tree', () => {
    it('finds no construction without one', () => {
        const sources = import.meta.glob('./*.test.ts', { query: '?raw', import: 'default', eager: true });

        const offenders: string[] = [];

        for (const [file, raw] of Object.entries(sources)) {
            const source = raw as string;
            // Deliberately NOT split on '\n': these files are checked out with CRLF on Windows,
            // and a line-based scan silently matches nothing there. Matched over the whole text.
            for (const match of source.matchAll(/new (?:AgentSession|SessionHost)\(\{[\s\S]{0,600}?\}\)/g)) {
                if (!match[0].includes('processTree')) {
                    offenders.push(`${file}: ${match[0].slice(0, 80).replace(/\s+/g, ' ')}…`);
                }
            }
        }

        expect(offenders).toEqual([]);
    });

    it('found constructions at all — the positive control', () => {
        /**
         * Without this, the assertion above passes on a scan that matched nothing: a changed
         * constructor style, a renamed class, or a glob that stopped resolving would all read
         * as "no offenders".
         */
        const sources = import.meta.glob('./*.test.ts', { query: '?raw', import: 'default', eager: true });

        let found = 0;
        for (const raw of Object.values(sources)) {
            found += [...(raw as string).matchAll(/new (?:AgentSession|SessionHost)\(\{/g)].length;
        }

        expect(found).toBeGreaterThan(10);
    });
});
