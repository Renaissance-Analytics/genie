// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SettingsSurface } from '../src/renderer/components/FeatureSurfaces.js';
import { EMPTY_FEATURES, type FeatureAction, type FeatureData } from '../src/renderer/features.js';

/**
 * ADF B5 (Tynn #455): THE SWITCH ON THE PLUGINS PAGE. "Turn off publisher checks" asks first, with the risk in words;
 * while publisher checks are off a banner says so; a package running only because of that wears **Unverified** and has
 * no network until the person allows it, from its row. Turning publisher checks back ON asks nothing: it is the safe way.
 * Interaction is a claim about a live DOM, so this renders in happy-dom (docs/decisions.md D4).
 */
const RISK = 'Unsigned or unknown publishers can run code on this machine. You accept that risk.';
const unverified = {
    id: 'com.example.local', folder: 'local', name: 'local', version: '1.0.0', state: 'enabled' as const, label: 'Unverified', reason: null,
    unverified: true, networkHosts: ['api.example.com'], networkAllowed: false,
};
const signed = {
    id: 'com.example.signed', folder: 'signed', name: 'Signed', version: '1.0.0', state: 'enabled' as const, label: 'signed by sha256:abc', reason: null,
    unverified: false, networkHosts: ['api.example.com'], networkAllowed: true,
};
const plugins = (over: Partial<NonNullable<FeatureData['plugins']>> = {}): NonNullable<FeatureData['plugins']> => ({
    dir: '/home/u/.genie/plugins', publisherChecksOff: false, panels: [], entries: [signed], ...over,
} as NonNullable<FeatureData['plugins']>);

let host: HTMLDivElement;
let root: Root;
let actions: FeatureAction[];
const g = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
beforeEach(() => {
    g.IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    actions = [];
});
afterEach(() => {
    act(() => root.unmount());
    host.remove();
    document.body.innerHTML = '';
});
const draw = (p: NonNullable<FeatureData['plugins']>) => act(() => {
    root.render(<SettingsSurface data={{ ...EMPTY_FEATURES, settings: { values: {} }, plugins: p }} onAction={(a) => { actions.push(a); }} onNavigate={() => {}} section="plugins" />);
});
const theSwitch = () => document.querySelector('[data-publisher-checks] [aria-checked]') as HTMLElement | null;
const click = (el: Element | null) => act(() => { (el as HTMLElement).click(); });

describe('"Turn off publisher checks"', () => {
    it('is on the Plugins page, unchecked while publisher checks are on; no banner then', () => {
        draw(plugins());
        expect(document.querySelector('[data-publisher-checks]')?.textContent).toContain('Turn off publisher checks');
        expect(theSwitch()?.getAttribute('aria-checked')).toBe('false');
        expect(document.querySelector('[data-publisher-checks-banner]')).toBeNull();
    });

    it('turning it on asks first, the risk in words; Cancel changes nothing', () => {
        draw(plugins());
        click(theSwitch());
        expect(actions).toEqual([]);
        expect(document.body.textContent).toContain(RISK);
        click(document.querySelector('[data-action="publisher-checks-cancel"]'));
        expect(actions).toEqual([]);
        expect(document.body.textContent).not.toContain(RISK);
    });

    it('confirmed, publisher checks are turned off', () => {
        draw(plugins());
        click(theSwitch());
        click(document.querySelector('[data-action="publisher-checks-off-confirm"]'));
        expect(actions).toEqual([{ kind: 'settings.set', key: 'publisher_checks_off', value: true }]);
    });

    it('while they are off, a banner says so; turning checks back on asks nothing', () => {
        draw(plugins({ publisherChecksOff: true }));
        const banner = document.querySelector('[data-publisher-checks-banner]');
        expect(banner?.textContent).toMatch(/Publisher checks are off/);
        expect(theSwitch()?.getAttribute('aria-checked')).toBe('true');
        click(theSwitch());
        expect(actions).toEqual([{ kind: 'settings.set', key: 'publisher_checks_off', value: false }]);
        expect(document.body.textContent).not.toContain(RISK);
    });
});

describe('an Unverified package', () => {
    it('wears the Unverified badge and offers to allow its network, naming the hosts', () => {
        draw(plugins({ publisherChecksOff: true, entries: [signed, unverified] }));
        const row = document.querySelector('[data-plugin="com.example.local"]')!;
        expect(row.querySelector('[data-plugin-unverified]')?.textContent).toBe('Unverified');
        expect(row.textContent).toMatch(/No network.*api\.example\.com/);
        click(row.querySelector('[data-action="plugin-allow-network"]'));
        expect(actions).toEqual([{ kind: 'plugins.setNetworkAllowed', id: 'com.example.local', allowed: true }]);
        // CONTROL: a signed package wears no Unverified badge and has nothing to allow.
        const signedRow = document.querySelector('[data-plugin="com.example.signed"]')!;
        expect(signedRow.querySelector('[data-plugin-unverified]')).toBeNull();
        expect(signedRow.querySelector('[data-action="plugin-allow-network"]')).toBeNull();
    });

    it('allowed, it offers to take the network back', () => {
        draw(plugins({ publisherChecksOff: true, entries: [{ ...unverified, networkAllowed: true }] }));
        click(document.querySelector('[data-plugin="com.example.local"] [data-action="plugin-block-network"]'));
        expect(actions).toEqual([{ kind: 'plugins.setNetworkAllowed', id: 'com.example.local', allowed: false }]);
    });
});
