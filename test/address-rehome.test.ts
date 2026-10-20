import { describe, expect, it } from 'vitest';
import { rehomeAddress } from '../src/core/address.js';

/**
 * LEAVING A REMOTE HOST LANDS ON THE SAME PAGE HERE (the two-VM proof, 2026-10-20). Driving another machine, the window's
 * address names THAT machine (`genie://omarchy-test/settings/remote`); after Disconnect it named a workstation this Genie
 * is not, resolved to nothing, and the window fell to the Dashboard — away from Remote access, where the host it just left
 * is remembered and Reconnect is. The address is re-homed: same page, this machine's name.
 */
describe('rehomeAddress', () => {
    it('the host it left → this machine, the rest of the address kept', () => {
        expect(rehomeAddress('genie://omarchy-test/settings/remote', 'omarchy-test', 'genie-test-win')).toBe('genie://genie-test-win/settings/remote');
        expect(rehomeAddress('genie://Omarchy-Test/dashboard?group=status', 'omarchy-test', 'desk')).toBe('genie://desk/dashboard?group=status');
    });

    it('an address of any other workstation, or not an address, is left alone (CONTROL)', () => {
        expect(rehomeAddress('genie://desk/settings/remote', 'omarchy-test', 'desk')).toBe('genie://desk/settings/remote');
        expect(rehomeAddress('genie://other/dashboard', 'omarchy-test', 'desk')).toBe('genie://other/dashboard');
        expect(rehomeAddress('genie://settings', 'omarchy-test', 'desk')).toBe('genie://settings');
    });
});
