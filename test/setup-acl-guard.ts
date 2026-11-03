import { afterAll, afterEach, expect } from 'vitest';
import { aclLinesOf, unexplainedAclFailures } from './helpers/acl-guard.js';

/**
 * EVERY TEST FILE RUNS UNDER THIS (vite.config.ts). A PRIVATE_CREDENTIAL_ACL_FAILURE nobody provoked fails the test it lands on. A line can land on the next test (a failed test's
 * work outlives it), and the last line in a file on nothing, so the file's end checks too. What is not seen: a test that replaces console.warn with its own mock, and a real host
 * process's own stderr, which is another process.
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
afterAll(() => check('at the end of this file'));
