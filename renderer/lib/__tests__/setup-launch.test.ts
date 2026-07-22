import { describe, it, expect } from 'vitest';
import { shouldOpenWorkstationSetup, type SetupStatusView } from '../setup-launch';

const needed: SetupStatusView = {
    complete: false,
    needed: true,
    steps: { agents: false, github: false },
};
const done: SetupStatusView = {
    complete: true,
    needed: false,
    steps: { agents: true, github: true },
};

describe('shouldOpenWorkstationSetup — the launch decision', () => {
    it('opens when the host reports setup needed and nothing is open yet', () => {
        expect(shouldOpenWorkstationSetup(needed, { alreadyOpen: false })).toBe(true);
    });

    it('does NOT reopen when a wizard is already open (idempotent)', () => {
        expect(shouldOpenWorkstationSetup(needed, { alreadyOpen: true })).toBe(false);
    });

    it('does NOT open when the host reports setup complete', () => {
        expect(shouldOpenWorkstationSetup(done, { alreadyOpen: false })).toBe(false);
    });

    it('does NOT open when the status is unknown (a link blip must not nag)', () => {
        expect(shouldOpenWorkstationSetup(null, { alreadyOpen: false })).toBe(false);
        expect(shouldOpenWorkstationSetup(undefined, { alreadyOpen: false })).toBe(false);
    });
});
