import { describe, expect, it } from 'vitest';
import { cloudHostVisual, cloudWorkstationsOnly } from '../cloud-host-visual';

describe('cloudHostVisual', () => {
    it('is green for a connected cloud host', () => {
        expect(cloudHostVisual({ status: 'active', connectable: true }, true)).toMatchObject({ color: 'green', pulse: false });
    });
    it('pulses green when that connection has active terminals', () => {
        expect(cloudHostVisual({ status: 'active', connectable: true }, true, true)).toMatchObject({ color: 'green', pulse: true });
    });
    it('is yellow when online but not connected', () => {
        expect(cloudHostVisual({ status: 'active', connectable: true }, false)).toMatchObject({ color: 'yellow', pulse: false });
    });
    it('pulses blue while an update is being installed', () => {
        expect(cloudHostVisual({ status: 'upgrading', connectable: false }, false)).toMatchObject({ color: 'blue', pulse: true });
    });
    it('is red when the cloud host is unavailable', () => {
        expect(cloudHostVisual({ status: 'unreachable', connectable: false }, false)).toMatchObject({ color: 'red', pulse: false });
    });
});

describe('cloudWorkstationsOnly', () => {
    it('never presents local Genie registrations as cloud workstations', () => {
        expect(cloudWorkstationsOnly([
            { id: 'local', is_local: true },
            { id: 'cloud', is_local: false },
        ])).toEqual([{ id: 'cloud', is_local: false }]);
    });
});
