import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { validateSiteForm, type SiteForm } from '../src/core/forms.js';
import { AddSiteForm } from '../src/renderer/components/AddForms.js';
import { ToolchainSurface } from '../src/renderer/components/FeatureSurfaces.js';
import { EMPTY_FEATURES, type FeatureData } from '../src/renderer/features.js';

/**
 * T4 — WHAT A PERSON SEES: the Toolchain surface lists the PHP versions Genie manages (Remove disabled, with the reason,
 * while a site is pinned to one), the PATH PHP an unpinned site runs, and an Install per version this release offers —
 * or, on macOS/Linux, why there is none. The site form offers a PHP version select, and a pin is validated with the form.
 */

const render = (toolchain: FeatureData['toolchain']) => renderToStaticMarkup(<ToolchainSurface data={{ ...EMPTY_FEATURES, toolchain }} onAction={() => {}} onNavigate={() => {}} />);
const base = { tools: [], checkedAt: 1 };

describe('Toolchain → PHP versions', () => {
    it('managed versions, each Remove disabled while pinned (naming the site); the PATH PHP; Install per version not here', () => {
        const html = render({
            ...base,
            php: {
                managed: [
                    { version: '8.4.26', dir: 'C:\\genie2-toolchain\\php-versions\\8.4.26', usedBy: ['shop.gen'] },
                    { version: '8.3.35', dir: 'C:\\genie2-toolchain\\php-versions\\8.3.35', usedBy: [] },
                ],
                system: { version: '8.4.13' },
                available: [{ version: '8.5.11', installed: false }, { version: '8.4.26', installed: true }, { version: '8.3.35', installed: true }],
            },
        });
        expect(html).toContain('data-php-versions="2"');
        expect(html).toMatch(/data-php-version="8\.4\.26" data-php-used="1"/);
        expect(html).toMatch(/pinned by shop\.gen/);
        expect(html).toMatch(/<button[^>]*disabled=""[^>]*title="Pinned by shop\.gen[^"]*"[^>]*>Remove/);
        // Control: the unpinned version's Remove is live.
        expect(html).toMatch(/data-php-version="8\.3\.35" data-php-used="0"[^]*?<button type="button" class="ml-auto shrink-0 text-\[13px\]">Remove/);
        expect(html).toMatch(/Unpinned php sites run PHP 8\.4\.13 from your PATH/);
        expect(html).toContain('data-php-install="8.5.11"');
        expect(html).not.toContain('data-php-install="8.4.26"');
    });

    it('macOS/Linux: no Install buttons — the reason instead', () => {
        const html = render({ ...base, php: { managed: [], system: { version: '8.3.6' }, available: [], installRefused: 'Genie installs PHP versions on Windows' } });
        expect(html).toContain('data-php-install-refused');
        expect(html).not.toContain('data-php-install=');
    });

    it('no PHP view yet: no PHP section (never an empty one)', () => {
        expect(render(base)).not.toContain('data-php-versions');
    });
});

describe('the site form’s PHP version', () => {
    const defaults = { name: 'shop', mode: 'php' as const, devServer: null, hostPort: null, root: 'public', spa: false, hint: '' };
    const form = (over: Partial<SiteForm>): SiteForm => ({ ...defaults, ...over });

    it('a select of the PATH PHP and each managed version; a pin to a version not installed stays visible as such', () => {
        const html = renderToStaticMarkup(<AddSiteForm defaults={{ ...defaults, phpVersion: '7.4' }} existingHosts={[]} problems={[]} phpVersions={['8.4.26', '8.3.35']} onSubmit={() => {}} onCancel={() => {}} />);
        expect(html).toContain('data-php-version-select');
        expect(html).toMatch(/<option value="">The PHP on your PATH<\/option>/);
        expect(html).toMatch(/<option value="8\.4\.26">PHP 8\.4\.26 — managed by Genie<\/option>/);
        expect(html).toMatch(/<option value="7\.4" selected="">PHP 7\.4 — not installed<\/option>/);
    });

    it('validation: a pin must be a version, and only a php site takes one; no pin is fine', () => {
        expect(validateSiteForm(form({ phpVersion: '8.4' }), [])).toEqual([]);
        expect(validateSiteForm(form({ phpVersion: null }), [])).toEqual([]);
        expect(validateSiteForm(form({ phpVersion: 'latest' }), []).map((p) => p.field)).toEqual(['phpVersion']);
        expect(validateSiteForm(form({ mode: 'static', root: 'dist', phpVersion: '8.4' }), []).map((p) => p.field)).toEqual(['phpVersion']);
    });
});
