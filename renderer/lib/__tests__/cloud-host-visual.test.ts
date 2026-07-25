import { describe, expect, it } from 'vitest';
import { cloudHostVisual, unifiedCloudWorkstations } from '../cloud-host-visual';

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

describe('unifiedCloudWorkstations', () => {
    it('filters local identities and dedupes cloud rows already represented by desktop discovery', () => {
        expect(unifiedCloudWorkstations(
            [
                { id: 'local-by-flag', name: 'This Genie', is_local: true },
                { id: 'local-by-id', name: 'Stale local row', is_local: false },
                { id: 'cloud-duplicate', name: 'Build Host', is_local: false },
                { id: 'cloud-duplicate', name: 'Build Host duplicate', is_local: false },
                { id: 'cloud-only', name: 'Cloud Only', is_local: false },
            ],
            [{ name: 'build host', hostname: 'build-host.tailnet' }],
            'local-by-id',
        )).toEqual([{ id: 'cloud-only', name: 'Cloud Only', is_local: false }]);
    });
});
