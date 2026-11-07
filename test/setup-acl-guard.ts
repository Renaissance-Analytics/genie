import { afterAll, afterEach, expect } from 'vitest';
import { checkAclLines, END_OF_FILE_HOOK_MS, endOfFileCheck } from './helpers/acl-guard.js';

/**
 * EVERY TEST FILE RUNS UNDER THIS (vite.config.ts). A PRIVATE_CREDENTIAL_ACL_FAILURE nobody provoked fails the test it lands on. A line can land on the next test (a failed test's
 * work outlives it), and the last line in a file on nothing, so the file's end checks too. What is not seen: a test that replaces console.warn with its own mock, a real host
 * process's own stderr, which is another process, and a line that arrives after its file has finished.
 */
const warned: unknown[][] = [];
const realWarn = console.warn.bind(console);
console.warn = (...args: unknown[]) => { warned.push(args); realWarn(...args); };

afterEach(() => checkAclLines(warned, expect.getState().testPath, 'during or just before this test'));
// A moment first: hooks run with no turn of the timers between them, so without it a line just after the last test lands after this has looked.
afterAll(() => endOfFileCheck(warned, expect.getState().testPath, { report: realWarn }), END_OF_FILE_HOOK_MS);
