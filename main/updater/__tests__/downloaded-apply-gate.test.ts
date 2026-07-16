import { describe, expect, it, vi } from 'vitest';

import '../../../test/electron-mock';

/**
 * The gate that decides whether an ARMED (installWhenReady) update-downloaded
 * applies HANDS-FREE or HOLDS for the user to confirm the restart. It must hold
 * whenever a restart would tear down live work — the fix for "an upgrade killed
 * my live agent chat with no warning". Pure + stack-safe (runs on every download-
 * complete). We mock the auto-updater module's heavy siblings so the pure export
 * loads without electron-updater / the real host wiring.
 */
vi.mock('electron-updater', () => ({ autoUpdater: {} }));
vi.mock('../git-updater', () => ({ isNewer: () => false }));
vi.mock('../quit-state', () => ({ markQuittingForUpdate: () => {} }));
vi.mock('../update-surface', () => ({
    appImageUpdateUnavailable: () => false,
    planManualDownload: () => ({ available: false }),
}));

import { decideDownloadedApply } from '../auto-updater';

describe('decideDownloadedApply — hands-free apply vs hold-for-confirm', () => {
    it('applies when nothing would be interrupted (null probe)', () => {
        expect(decideDownloadedApply(null)).toBe('apply');
    });

    it('applies when no terminals are live', () => {
        expect(decideDownloadedApply({ terminals: 0, agentChats: 0 })).toBe('apply');
    });

    it('HOLDS when a live agent chat would be interrupted', () => {
        expect(decideDownloadedApply({ terminals: 2, agentChats: 1 })).toBe('hold');
    });

    it('HOLDS for any live terminal, even a non-agent shell', () => {
        expect(decideDownloadedApply({ terminals: 1, agentChats: 0 })).toBe('hold');
    });
});
