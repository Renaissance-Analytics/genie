import { describe, expect, it } from 'vitest';
import { thisMachineWorkstationIds } from '../src/main/this-machine.js';

/**
 * WHICH TYNN RECORDS ARE THIS MACHINE (see connect-this-machine.test.ts for the measurement on the owner's desktop): the
 * one this launch registered, the one Genie 2 has stored (registered or not this launch: signed in before Tynn
 * answered, Tynn unreachable at boot), and the one Genie 1 registered from the userData Genie 2 shares.
 */
describe('thisMachineWorkstationIds', () => {
    it('all three, each once', () => {
        const ids = thisMachineWorkstationIds({ registered: 'ws_v2', stored: 'ws_v2', v1Settings: { workstation_id: 'ws_v1', theme: 'dark' } });
        expect([...ids].sort()).toEqual(['ws_v1', 'ws_v2']);
    });

    it('stored but not registered this launch: still this machine', () => {
        expect([...thisMachineWorkstationIds({ registered: null, stored: 'ws_v2', v1Settings: null })]).toEqual(['ws_v2']);
    });

    it('a Genie 1 install that never registered (no or empty workstation_id) adds nothing', () => {
        expect([...thisMachineWorkstationIds({ registered: 'ws_v2', stored: null, v1Settings: { workstation_id: '' } })]).toEqual(['ws_v2']);
        expect([...thisMachineWorkstationIds({ registered: null, stored: null, v1Settings: {} })]).toEqual([]);
    });
});
