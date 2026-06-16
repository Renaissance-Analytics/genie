import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import '../../../test/electron-mock';

/**
 * `willRestartPtyHost` on the updater status payload must reflect the ACTIVE
 * BACKEND KIND, true ONLY for the 'detached' host — the one that pins Genie's
 * binary and so must be killed + restarted on an update. A 'service'-backed host
 * runs on its own standalone Node runtime and SURVIVES the update (no restart →
 * flag false, no warning); 'inprocess' has no host at all (flag false). The
 * update pill uses this to warn the user before they apply only when terminals
 * will actually restart.
 */

let backendKind: 'service' | 'detached' | 'inprocess' = 'inprocess';
// Whether the detached host pins Genie's binary (electron-spawn) — true unless
// it ran on the standalone Node. Conservative default mirrors production.
let pinsBinary = true;

vi.mock('../../terminal/host-service', () => ({
    hostBackendKind: () => backendKind,
    detachedHostPinsBinary: () => pinsBinary,
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
    backendKind = 'inprocess';
    pinsBinary = true;
});

afterEach(() => {
    vi.restoreAllMocks();
});

describe('withHostFlag', () => {
    it('sets willRestartPtyHost=true when the active backend is the detached host', () => {
        backendKind = 'detached';
        const out = withHostFlag(baseStatus);
        // Detached host pins Genie's binary → update kills + restarts it → warn.
        expect(out.willRestartPtyHost).toBe(true);
        // original fields preserved
        expect(out.latestVersion).toBe('0.7.0-alpha.44');
    });

    it('sets willRestartPtyHost=false for a detached host on standalone Node (does not pin)', () => {
        // Detached, but launched on the shipped standalone Node → does not pin
        // genie.exe → survives the update → no restart, no warning.
        backendKind = 'detached';
        pinsBinary = false;
        expect(withHostFlag(baseStatus).willRestartPtyHost).toBe(false);
    });

    it('sets willRestartPtyHost=false for a service-backed host (survives the update)', () => {
        // Service host runs on its own standalone Node runtime — never pins the
        // binary, reconnects after the swap, terminals stay live → no restart.
        backendKind = 'service';
        expect(withHostFlag(baseStatus).willRestartPtyHost).toBe(false);
    });

    it('sets willRestartPtyHost=false when in-process (no host at all)', () => {
        backendKind = 'inprocess';
        expect(withHostFlag(baseStatus).willRestartPtyHost).toBe(false);
    });
});
