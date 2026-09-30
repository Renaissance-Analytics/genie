import { describe, expect, it } from 'vitest';
import { formatPtyExit } from '../host-diagnostics';

/**
 * THE EXIT LINE — what the log was missing while a crashloop hid inside it.
 *
 * `formatHostSpawnRequest` recorded every attempt to start a pty and nothing
 * about the outcome. Three workers restarted 9,306 times over five days and the
 * log read as ordinary activity: nine thousand "started", not one "and then it
 * died". Diagnosing it meant counting lines and inferring a period, because the
 * file physically did not contain a reason.
 */
describe('a pty that ended', () => {
    it('records identity, outcome and how long it lived', () => {
        const line = formatPtyExit({
            id: 'p1',
            label: 'Moic Chat Worker',
            provider: 'process',
            exitCode: 1,
            lifetimeMs: 4_200,
        });

        expect(line).toContain('pty exited');
        expect(line).toContain('"id":"p1"');
        expect(line).toContain('"label":"Moic Chat Worker"');
        expect(line).toContain('"code":1');
        // THE field that makes a loop legible: 4 seconds is a crashloop, four
        // hours is a service that finished. The old log could not tell them apart.
        expect(line).toContain('"lifetimeMs":4200');
    });

    it('decodes a native fault the same way a host exit is decoded', () => {
        expect(formatPtyExit({ id: 'p1', exitCode: 0xc0000005 })).toContain('access violation');
    });

    it('says UNKNOWN rather than guessing at an undocumented status', () => {
        expect(formatPtyExit({ id: 'p1', exitCode: 42 })).toContain('UNKNOWN');
    });

    it('NEVER carries the command, its arguments or its output', () => {
        // Same allowlist as the spawn breadcrumb. A log that is unsafe to read is
        // a log nobody may paste into an issue, which makes it useless.
        const line = formatPtyExit({
            id: 'p1',
            label: 'Worker',
            provider: 'process',
            exitCode: 1,
            lifetimeMs: 10,
        });
        expect(line).not.toMatch(/token|secret|password|--/i);
        expect(Object.keys(JSON.parse(line.slice(line.indexOf('{'), line.lastIndexOf('}') + 1)))).toEqual([
            'id',
            'provider',
            'label',
            'code',
            'signal',
            'lifetimeMs',
        ]);
    });
});
