import { describe, expect, it } from 'vitest';
import { describeFlowSource } from '../flow-view';

/**
 * Whose Flows is the manager showing?
 *
 * A remote window drives another machine, and every surface in it is about the
 * HOST. The Flow Manager is not: `api().flows.*` is not routed over the remote
 * bridge, so it reads THIS workstation's flows — and `broadcastLocal` skips
 * host-bound windows, so the header receives no run activity from either
 * machine.
 *
 * That combination is worse than an unsupported feature. It is a panel that
 * looks identical to the local case and is about a different computer than the
 * one the user believes they are looking at. The fix is not to hide the gap but
 * to name it, in the panel, every time.
 *
 * ## Why the sentence is computed here
 *
 * Because the alternative is a component deciding it, and a surface that
 * decides for itself whose data it is showing is exactly how the two panes end
 * up disagreeing. One function, one answer, asserted.
 */

describe('the Flow Manager says whose Flows these are', () => {
    it('says nothing at all in a local window', () => {
        // No banner, no caveat, no ceremony: local is the case where the panel
        // means what it appears to mean.
        expect(describeFlowSource({ remote: false })).toBeNull();
    });

    it('names the host, and says these Flows are NOT its', () => {
        const note = describeFlowSource({ remote: true, hostName: 'studio-mac' });
        expect(note).toContain('this workstation');
        // The host is NAMED. "Not the remote host's" would leave the user
        // working out which machine they are connected to.
        expect(note).toContain('studio-mac');
    });

    it('still says which machine it means when the host has no name yet', () => {
        const note = describeFlowSource({ remote: true });
        // The status round-trip may not have landed. The panel must not fall
        // silent and look local while it waits.
        expect(note).toContain('this workstation');
        expect(note).not.toContain('undefined');
    });
});
