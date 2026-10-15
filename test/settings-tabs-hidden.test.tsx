import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SETTINGS } from '../src/core/settings.js';
import { SettingsSurface } from '../src/renderer/components/FeatureSurfaces.js';
import { EMPTY_FEATURES } from '../src/renderer/features.js';

/**
 * THE SETTINGS TABS DRAW WHAT A PERSON CHOOSES. An INTERNAL setting (`hidden: true`) is "remembered, never drawn and
 * never found by search" (core/settings.ts) — search honoured it, the tabs did not, so the one-time tray notice's
 * marker would have been a toggle in General (and the pane splits a text box in Workstation). The tray-resident pair
 * IS drawn there: Start minimized to tray, Launch at sign-in.
 */

const render = (group: 'general' | 'workstation') =>
    renderToStaticMarkup(<SettingsSurface data={{ ...EMPTY_FEATURES, settings: { values: {} } }} onAction={() => {}} onNavigate={() => {}} group={group} />);

describe('settings tabs', () => {
    it('draw start minimised and launch at sign-in, and NOT the tray notice marker', () => {
        const html = render('general');
        expect(html).toContain('data-setting="start_minimized"');
        expect(html).toContain('data-setting="launch_at_login"');
        expect(html).not.toContain('data-setting="tray_notice_shown"');
    });

    it('draw no hidden setting in any tab — counted against the registry', () => {
        const hidden = SETTINGS.filter((s) => s.hidden).map((s) => s.key);
        const html = render('general') + render('workstation');
        expect(hidden.filter((k) => html.includes(`data-setting="${k}"`))).toEqual([]);
        expect(hidden).toEqual(expect.arrayContaining(['tray_notice_shown', 'panel_splits']));
        // CONTROL: the tabs render all panels, so a visible workstation setting IS found in the same markup.
        expect(html).toContain('data-setting="track_cwd"');
    });
});
