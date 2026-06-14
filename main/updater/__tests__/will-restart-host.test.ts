import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import '../../../test/electron-mock';

/**
 * `willRestartPtyHost` on the updater status payload must reflect
 * `isHostBacked()` — true only when a detached pty-host is active (so applying
 * the update will kill + restart it). The update pill uses this to warn the
 * user before they apply.
 */

let hostBacked = false;

vi.mock('@particle-academy/fancy-term-host', () => ({
    isHostBacked: () => hostBacked,
}));

// registerUpdaterIpc transitively imports these; keep them inert so the module
// graph loads. We only exercise the pure withHostFlag helper here.
vi.mock('../git-updater', () => ({ updater: () => ({}) }));
vi.mock('../auto-updater', () => ({
    autoUpdaterInstance: () => ({}),
    updaterMode: () => 'phase2',
}));
vi.mock('../../db', () => ({ getAllSettings: () => ({}), setSettings: () => {} }));
vi.mock('../../tray', () => ({ setUpdateAvailable: () => {} }));
vi.mock('../../background', () => ({ showSettingsWindow: () => {} }));
vi.mock('../changelog', () => ({ getChangelog: async () => ({}) }));

import { withHostFlag } from '../ipc';

const baseStatus = {
    state: 'ready-to-restart' as const,
    currentVersion: '0.7.0-alpha.43',
    latestVersion: '0.7.0-alpha.44',
    publishedAt: null,
    releaseUrl: null,
    log: [],
    error: null,
    progress: 1,
};

beforeEach(() => {
    hostBacked = false;
});

afterEach(() => {
    vi.restoreAllMocks();
});

describe('withHostFlag', () => {
    it('sets willRestartPtyHost=true when host-backed', () => {
        hostBacked = true;
        const out = withHostFlag(baseStatus);
        expect(out.willRestartPtyHost).toBe(true);
        // original fields preserved
        expect(out.latestVersion).toBe('0.7.0-alpha.44');
    });

    it('sets willRestartPtyHost=false when not host-backed', () => {
        hostBacked = false;
        expect(withHostFlag(baseStatus).willRestartPtyHost).toBe(false);
    });
});
