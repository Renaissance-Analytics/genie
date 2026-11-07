import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ACL_FAILURE, aclLinesOf, END_OF_FILE_HOOK_MS, endOfFileCheck, unexplainedAclFailures } from './helpers/acl-guard.js';

/**
 * A FAILED ACL IS A QUESTION ABOUT SECRETS AT REST, NOT NOISE. PRIVATE_CREDENTIAL_ACL_FAILURE used to scroll past in stderr, twelve provoked lines a run, so a real one would have
 * read the same. Now one line anywhere fails the run, with the two files that provoke it on purpose as the only exceptions. test/setup-acl-guard.ts is what watches, in every file.
 */
const LINE = [[ACL_FAILURE, { reason: 'process-exit', code: 1 }]];

describe('which lines count', () => {
    it('a line in any other test file is unexplained', () => {
        expect(unexplainedAclFailures('C:\\repo\\test\\host-tynn-recovery.test.ts', LINE)).toEqual(LINE);
        expect(unexplainedAclFailures('/repo/test/compose.test.ts', LINE)).toEqual(LINE);
    });

    it.each(['private-credentials-launch-count', 'private-credentials-windows'])('%s provokes it on purpose: there it is explained, on either OS’s paths', (name) => {
        expect(unexplainedAclFailures(`/repo/test/${name}.test.ts`, LINE)).toEqual([]);
        expect(unexplainedAclFailures(`C:\\repo\\test\\${name}.test.ts`, LINE)).toEqual([]);
    });

    it('a file merely named like them is not an exception', () => {
        expect(unexplainedAclFailures('/repo/test/not-private-credentials-windows.test.ts', LINE)).toEqual(LINE);
    });

    it('with no test path it is unexplained: a line from outside any test still counts', () => {
        expect(unexplainedAclFailures(undefined, LINE)).toEqual(LINE);
    });

    it('only the failure line is picked out of what is warned', () => {
        expect(aclLinesOf([['something else'], [ACL_FAILURE, {}], ['PRIVATE_CREDENTIAL_ACL_FAILURE_NOT', {}]])).toEqual([[ACL_FAILURE, {}]]);
    });
});

describe('the end of a file: only an ACL line fails it, never a clock', () => {
    const PLAIN = '/repo/test/compose.test.ts';
    const PROVOKED = '/repo/test/private-credentials-windows.test.ts';
    const line = () => [...LINE] as unknown[][];
    afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

    it('fake timers on: it still finishes, on the real clock', async () => {
        vi.useFakeTimers();
        await expect(endOfFileCheck([], PLAIN)).resolves.toBeUndefined();
    });

    it('fake timers on: a real unexplained line still fails', async () => {
        vi.useFakeTimers();
        await expect(endOfFileCheck(line(), PLAIN)).rejects.toThrow(/A failed ACL no test provoked, at the end of this file/);
    });

    it('fake timers on: a file that provokes the line on purpose still passes (CONTROL)', async () => {
        vi.useFakeTimers();
        await expect(endOfFileCheck(line(), PROVOKED)).resolves.toBeUndefined();
    });

    it('a setTimeout replaced outright is not the one it uses', async () => {
        vi.stubGlobal('setTimeout', () => { throw new Error('the mocked timer was used'); });
        await expect(endOfFileCheck([], PLAIN)).resolves.toBeUndefined();
    });

    it('it does wait: a line just after it starts is still seen', async () => {
        const warned: unknown[][] = [];
        const checked = endOfFileCheck(warned, PLAIN);
        warned.push(...line());
        await expect(checked).rejects.toThrow(/A failed ACL no test provoked/);
    });

    it('a stall is read and reported by both clocks, and fails nothing', async () => {
        const report = vi.fn();
        await expect(endOfFileCheck([], PLAIN, { report, moment: async () => ({ monotonicMs: 10_400, wallMs: 10_410 }) })).resolves.toBeUndefined();
        expect(report).toHaveBeenCalledTimes(1);
        expect(report.mock.calls[0]![0]).toMatch(/^TEST_CLOCK_STALL .*25 ms.*10400 ms.*10410 ms/);
    });

    it('a stall does not excuse a line', async () => {
        const report = vi.fn();
        await expect(endOfFileCheck(line(), PLAIN, { report, moment: async () => ({ monotonicMs: 10_400, wallMs: 10_410 }) })).rejects.toThrow(/A failed ACL no test provoked/);
        expect(report).toHaveBeenCalledTimes(1);
    });

    it('a moment of ordinary length reports nothing (CONTROL), and neither clock alone is missed', async () => {
        const report = vi.fn();
        await endOfFileCheck([], PLAIN, { report, moment: async () => ({ monotonicMs: 30, wallMs: 31 }) });
        expect(report).not.toHaveBeenCalled();
        // A clock stepped forward: the wall reads a jump the monotonic clock did not see.
        await endOfFileCheck([], PLAIN, { report, moment: async () => ({ monotonicMs: 30, wallMs: 12_000 }) });
        expect(report).toHaveBeenCalledTimes(1);
    });

    it('the hook is allowed far longer than a stall has lasted: 10.7 s measured, 10 s was the old limit', () => {
        expect(END_OF_FILE_HOOK_MS).toBeGreaterThanOrEqual(300_000);
    });
});

describe('wired', () => {
    it('every test file in the suite runs under the guard', () => {
        expect(readFileSync('vite.config.ts', 'utf8')).toMatch(/setupFiles: \['test\/setup-acl-guard\.ts'\]/);
    });

    it('the name it watches for is the one the product prints', () => {
        expect(readFileSync('src/main/private-credentials.ts', 'utf8')).toContain(`console.warn('${ACL_FAILURE}'`);
    });

    it('the guard fails a test, and a file, rather than only printing', () => {
        const setup = readFileSync('test/setup-acl-guard.ts', 'utf8');
        expect(setup).toMatch(/afterEach\(/);
        expect(setup).toMatch(/afterAll\(/);
        expect(setup).toMatch(/endOfFileCheck\(/);
        expect(setup).toMatch(/END_OF_FILE_HOOK_MS\);/);
        expect(readFileSync('test/helpers/acl-guard.ts', 'utf8')).toMatch(/throw new Error/);
    });
});
