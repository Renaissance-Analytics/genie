import { afterAll, afterEach, expect } from 'vitest';
import { aclLinesOf, unexplainedAclFailures } from './helpers/acl-guard.js';

/**
 * EVERY TEST FILE RUNS UNDER THIS (vite.config.ts). A PRIVATE_CREDENTIAL_ACL_FAILURE nobody provoked fails the test it lands on. A line can land on the next test (a failed test's
 * work outlives it), and the last line in a file on nothing, so the file's end checks too. What is not seen: a test that replaces console.warn with its own mock, a real host
 * process's own stderr, which is another process, and a line that arrives after its file has finished.
 */
const warned: unknown[][] = [];
const realWarn = console.warn.bind(console);
console.warn = (...args: unknown[]) => { warned.push(args); realWarn(...args); };

function check(when: string): void {
    const lines = aclLinesOf(warned.splice(0));
    const unexplained = unexplainedAclFailures(expect.getState().testPath, lines);
    if (unexplained.length > 0) throw new Error(`A failed ACL no test provoked, ${when}: ${JSON.stringify(unexplained)}. This is a question about secrets at rest, not noise. See test/acl-guard.test.ts.`);
}
afterEach(() => check('during or just before this test'));
// A moment first: hooks run with no turn of the timers between them, so without it a line just after the last test lands after this has looked.
afterAll(async () => { await new Promise((r) => setTimeout(r, 25)); check('at the end of this file'); });
