import { describe, expect, it } from 'vitest';
import { shouldAutoProvisionOnOpen } from '../tynn-autoprovision';

describe('shouldAutoProvisionOnOpen (genie #52 — zero-click auto-connect on open)', () => {
    const ws = '/data/workspaces/new-dawn.agi';

    it('auto-provisions when linked-but-unconfigured (status "provision") and not yet attempted', () => {
        expect(shouldAutoProvisionOnOpen({ status: 'provision', attemptedFor: null, workspacePath: ws })).toBe(
            true,
        );
    });

    it('does NOT re-fire once attempted for the same workspace (no provision loop)', () => {
        expect(shouldAutoProvisionOnOpen({ status: 'provision', attemptedFor: ws, workspacePath: ws })).toBe(
            false,
        );
    });

    it('fires again for a DIFFERENT workspace', () => {
        expect(
            shouldAutoProvisionOnOpen({ status: 'provision', attemptedFor: ws, workspacePath: '/data/other.agi' }),
        ).toBe(true);
    });

    it.each(['already', 'unlinked', 'signed-out', null] as const)(
        'never auto-provisions on status %s',
        (status) => {
            expect(shouldAutoProvisionOnOpen({ status, attemptedFor: null, workspacePath: ws })).toBe(false);
        },
    );
});
