import { describe, expect, it } from 'vitest';
import { HOSTS_BEGIN, HOSTS_END, hostsFileBlock, mergeHostsFile } from '../src/core/gen-router.js';

/**
 * EVERY GENIE BLOCK IN THE HOSTS FILE IS GENIE'S TO REPLACE (hosting fixes 4.10). The merge removed only the FIRST
 * marked block, so a file that came to hold two (an interrupted write healed into a second, a copy pasted by hand, two
 * Genies) kept the stale one for good — a name no site serves any more still pointed at this machine, and a removed
 * name never left. Now every marked block goes, and the one current block takes the first one's place.
 */
const V1_BEGIN = '# BEGIN GENIE SITES';
const V1_END = '# END GENIE SITES';

describe('the hosts file merge', () => {
    it('two Genie blocks → ONE, current, where the first was; everything else byte-identical (counted)', () => {
        const before = ['127.0.0.1 localhost', HOSTS_BEGIN, '127.0.0.1 old.gen', HOSTS_END, '10.0.0.5 nas.example', HOSTS_BEGIN, '127.0.0.1 stale.gen', HOSTS_END, '::1 localhost', ''].join('\n');
        const after = mergeHostsFile(before, ['tynn.gen']);
        expect(after.split('\n').filter((l) => l === HOSTS_BEGIN)).toHaveLength(1);
        expect(after.split('\n').filter((l) => l === HOSTS_END)).toHaveLength(1);
        expect(after).not.toContain('stale.gen');
        expect(after).not.toContain('old.gen');
        expect(after).toBe(['127.0.0.1 localhost', hostsFileBlock(['tynn.gen']), '10.0.0.5 nas.example', '::1 localhost', ''].join('\n'));
    });

    it('no names: EVERY Genie block goes, markers and all', () => {
        const before = [HOSTS_BEGIN, '127.0.0.1 a.gen', HOSTS_END, '127.0.0.1 localhost', HOSTS_BEGIN, '127.0.0.1 b.gen', HOSTS_END, ''].join('\n');
        expect(mergeHostsFile(before, [])).toBe('127.0.0.1 localhost\n');
    });

    it('two of Genie 1’s blocks are both removed in the same pass', () => {
        const before = [V1_BEGIN, '127.0.0.1\tone.gen', V1_END, '127.0.0.1 localhost', V1_BEGIN, '127.0.0.1\ttwo.gen', V1_END, ''].join('\n');
        const after = mergeHostsFile(before, []);
        expect(after).toBe('127.0.0.1 localhost\n');
    });

    it('CONTROL: one block is replaced in place, as before, and a matching file comes back unchanged', () => {
        const before = ['127.0.0.1 localhost', HOSTS_BEGIN, '127.0.0.1 old.gen', HOSTS_END, ''].join('\n');
        const after = mergeHostsFile(before, ['tynn.gen']);
        expect(after).toBe(['127.0.0.1 localhost', hostsFileBlock(['tynn.gen']), ''].join('\n'));
        expect(mergeHostsFile(after, ['tynn.gen'])).toBe(after);
    });
});
