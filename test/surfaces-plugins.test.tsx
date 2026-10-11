import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SettingsSurface } from '../src/renderer/components/FeatureSurfaces.js';
import { EMPTY_FEATURES, type FeatureData } from '../src/renderer/features.js';

/**
 * PLUGINS IN SETTINGS → WORKSTATION (§6.7). Every plugin folder is listed with its state and label —
 * signed by whom, or UNSIGNED under developer mode — and a refused or invalid one shows its REASON
 * rather than vanishing. Enable/Disable for installable ones only. Empty says where plugins go.
 */

const plugins: NonNullable<FeatureData['plugins']> = {
    dir: '/home/u/.genie/plugins',
    developerMode: false,
    entries: [
        { id: 'com.example.presentation', folder: 'presentation', name: 'Presentation', version: '1.0.0', state: 'enabled', label: 'signed by example-2026', reason: null },
        { id: 'com.example.sheets', folder: 'sheets', name: 'Sheets', version: '0.3.0', state: 'disabled', label: 'signed by example-2026', reason: null },
        { id: 'com.example.localdev', folder: 'local-dev', name: 'localdev', version: '1.0.0', state: 'refused', label: null, reason: 'unsigned plugins are not installed: no signature file (genie-plugin.sig) beside the manifest. Turn on developer mode to run a local unsigned plugin, labelled as such.' },
        { id: '(broken)', folder: 'broken', name: 'broken', version: null, state: 'invalid', label: null, reason: 'unknown key "shell" — undeclared access does not exist; remove it or declare a known capability' },
    ],
};
const render = (p: FeatureData['plugins']) =>
    renderToStaticMarkup(<SettingsSurface data={{ ...EMPTY_FEATURES, settings: { values: {} }, plugins: p }} onAction={() => {}} onNavigate={() => {}} group="workstation" />);

describe('Plugins panel', () => {
    it('lists every entry with state, label and reason; nothing refused or invalid vanishes', () => {
        const html = render(plugins);
        expect(html).toContain('data-plugins');
        expect(html).toContain('data-plugin="com.example.presentation" data-plugin-state="enabled"');
        expect(html).toContain('data-plugin="com.example.sheets" data-plugin-state="disabled"');
        expect(html).toContain('data-plugin="com.example.localdev" data-plugin-state="refused"');
        expect(html).toContain('data-plugin="(broken)" data-plugin-state="invalid"');
        expect(html).toMatch(/signed by example-2026/);
        expect(html).toMatch(/unsigned plugins are not installed/);
        expect(html).toMatch(/unknown key “shell”|unknown key "shell"|unknown key &quot;shell&quot;/);
    });

    it('Enable/Disable only for installable plugins; the folder path is shown so a person knows where plugins go; null draws a skeleton', () => {
        const html = render(plugins);
        expect(html).toContain('data-action="plugin-disable" data-plugin-id="com.example.presentation"');
        expect(html).toContain('data-action="plugin-enable" data-plugin-id="com.example.sheets"');
        expect(html).not.toContain('data-plugin-id="com.example.localdev"');
        expect(html).not.toContain('data-plugin-id="(broken)"');
        expect(html).toMatch(/\/home\/u\/\.genie\/plugins/);
        expect(render(null)).toContain('data-plugins');
        expect(render({ ...plugins, entries: [] })).toMatch(/No plugins yet/);
    });

    it('developer mode is named when on: unsigned plugins run and are labelled', () => {
        const on = render({ ...plugins, developerMode: true, entries: [{ ...plugins.entries[2]!, state: 'enabled', label: 'UNSIGNED — developer mode', reason: null }] });
        expect(on).toMatch(/UNSIGNED — developer mode/);
        expect(on).toMatch(/Developer mode is on/);
        expect(render(plugins)).not.toMatch(/Developer mode is on/);
    });
});
