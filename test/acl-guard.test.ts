import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ACL_FAILURE, aclLinesOf, unexplainedAclFailures } from './helpers/acl-guard.js';

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
        expect(setup).toMatch(/throw new Error/);
    });
});
