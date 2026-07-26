import { describe, expect, it, vi } from 'vitest';

/**
 * genie #63 Phase 1 — the `detached_terminals` opt-in is RETIRED.
 *
 * Genie's own gate (`detachedTerminalsEnabled()` → `selectTerminalBackend`) is
 * deleted, but fancy-term-host's `initTerminalBackend()` carries its OWN copy of
 * the gate: it reads `settings.get('detached_terminals') === 'on'` through the
 * injected SettingsProvider and refuses to connect-or-spawn the detached host
 * otherwise. A user (or an old install) with an explicit `'off'` on disk would
 * therefore still veto the always-on local Host from inside the package — the
 * gate removal would be half-wired.
 *
 * The composition root owns that seam: `hostLifecycleSettings()` is the provider
 * handed to `configureHostLifecycle`, and it reports the retired gate as ON,
 * unconditionally. Every OTHER key still passes through to the db untouched.
 */

const h = vi.hoisted(() => ({
    settings: {} as Record<string, string | undefined>,
}));

vi.mock('../../db', () => ({
    getAllSettings: () => h.settings,
    updateTerminalSpec: () => {},
}));

import { dbSettingsProvider, hostLifecycleSettings } from '../genie-adapter';

describe('hostLifecycleSettings (retired detached_terminals gate)', () => {
    it('reports the retired gate ON even when the db says OFF', () => {
        h.settings = { detached_terminals: 'off', track_cwd: 'off' };
        expect(dbSettingsProvider().get('detached_terminals')).toBe('off');
        // The package's own gate must never see the stale opt-out.
        expect(hostLifecycleSettings().get('detached_terminals')).toBe('on');
    });

    it('reports the retired gate ON when the db has no value at all', () => {
        h.settings = {};
        expect(hostLifecycleSettings().get('detached_terminals')).toBe('on');
    });

    it('passes every other key straight through to the db provider', () => {
        h.settings = { detached_terminals: 'off', track_cwd: 'off', terminal_shell: 'bash' };
        const s = hostLifecycleSettings();
        expect(s.get('track_cwd')).toBe('off');
        expect(s.get('terminal_shell')).toBe('bash');
        expect(s.get('nope')).toBeUndefined();
    });
});
