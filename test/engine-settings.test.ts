import { describe, expect, it } from 'vitest';
import { engineSettingsFrom } from '../src/main/fancy-term-port.js';

/**
 * THE ENGINE READS GENIE'S SETTINGS (§6.5) — fancy-term-host gates its OSC-7 cwd hook and detached
 * terminals on a tiny settings port that speaks 'on' / 'off'. Until now that port was a literal
 * (`track_cwd: on, detached_terminals: off`), so the two settings in Genie's registry changed
 * nothing. The mapping is pure: Genie's booleans in, the engine's words out, the engine's own
 * default when a key is absent.
 */

describe('engineSettingsFrom', () => {
    it('maps the two booleans to on/off, answers undefined for a missing key, and ignores keys the engine does not ask about', () => {
        const s = engineSettingsFrom(() => ({ track_cwd: false, detached_terminals: true, theme: 'dark' }));
        expect(s.get('track_cwd')).toBe('off');
        expect(s.get('detached_terminals')).toBe('on');
        expect(s.get('theme')).toBeUndefined();
        expect(engineSettingsFrom(() => ({})).get('track_cwd')).toBeUndefined();
    });

    it('reads LIVE: a change in the store is seen on the next get', () => {
        let values: Record<string, boolean | string> = { track_cwd: true };
        const s = engineSettingsFrom(() => values);
        expect(s.get('track_cwd')).toBe('on');
        values = { track_cwd: false };
        expect(s.get('track_cwd')).toBe('off');
    });
});
