import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ToolchainSurface, playwrightInstallChosen } from '../src/renderer/components/FeatureSurfaces.js';
import { EMPTY_FEATURES, type FeatureData } from '../src/renderer/features.js';
import { PLAYWRIGHT_STABLE } from '../src/core/playwright-managed.js';

/**
 * Tynn #846 — Settings → Toolchain → Playwright: the installed versions, side by side, the stable one marked; a set whose
 * browsers are gone says so and installs again; any version can be installed by typing it; Install Chromium installs the
 * stable version (never whatever is newest that day).
 */
const view = (sets: Array<{ version: string; browsers: string[]; ready: boolean }>, latest: string | null = '1.66.0') =>
    ({ tools: [], checkedAt: 1, playwright: { browsersPath: '/data/genie2-toolchain/playwright/browsers', totalBytes: 0, sets, stable: PLAYWRIGHT_STABLE, latest, optional: ['firefox', 'webkit'] } }) as unknown as FeatureData['toolchain'];
const render = (toolchain: FeatureData['toolchain']) => renderToStaticMarkup(<ToolchainSurface data={{ ...EMPTY_FEATURES, toolchain }} onAction={() => {}} onNavigate={() => {}} />);

describe('#846 — the Playwright section', () => {
    it('names the stable version, and marks the installed set that is it', () => {
        const html = render(view([{ version: PLAYWRIGHT_STABLE, browsers: ['chromium'], ready: true }, { version: '1.62.1', browsers: ['chromium'], ready: true }]));
        expect(html).toContain(`data-playwright-stable="${PLAYWRIGHT_STABLE}"`);
        expect(html).toContain(`data-playwright-stable-set="${PLAYWRIGHT_STABLE}"`);
        expect(html).not.toContain('data-playwright-stable-set="1.62.1"');
    });
    it('lists every installed version side by side (COUNTED: two rows)', () => {
        const html = render(view([{ version: PLAYWRIGHT_STABLE, browsers: ['chromium'], ready: true }, { version: '1.62.1', browsers: ['chromium'], ready: true }]));
        expect([...html.matchAll(/data-playwright-version="([0-9.]+)"/g)].map((m) => m[1])).toEqual([PLAYWRIGHT_STABLE, '1.62.1']);
    });
    it('a set whose browsers are gone says so and offers to install it again', () => {
        const html = render(view([{ version: '1.62.1', browsers: ['chromium'], ready: false }]));
        expect(html).toContain('data-playwright-reinstall="1.62.1"');
    });
    it('offers any version to be installed by typing it', () => {
        const html = render(view([{ version: PLAYWRIGHT_STABLE, browsers: ['chromium'], ready: true }]));
        expect(html).toContain('data-playwright-version-input=""');
        expect(html).toContain('data-playwright-install-chosen=""');
    });
    it('with nothing installed, Install Chromium names the stable version it installs', () => {
        const html = render(view([]));
        expect(html).toContain(`Install Chromium (Playwright ${PLAYWRIGHT_STABLE})`);
    });
    it('a typed version becomes an install of that version’s Chromium; anything that is not x.y.z is not one', () => {
        expect(playwrightInstallChosen(' 1.62.1 ')).toEqual({ kind: 'toolchain.installPlaywright', version: '1.62.1', browsers: ['chromium'], consent: true });
        expect(playwrightInstallChosen('1.62')).toBeNull();
        expect(playwrightInstallChosen('latest')).toBeNull();
    });
});
