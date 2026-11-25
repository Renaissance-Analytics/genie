import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ToolchainSurface } from '../src/renderer/components/FeatureSurfaces.js';
import { EMPTY_FEATURES, type FeatureData } from '../src/renderer/features.js';

/**
 * Tynn #968: on Arch a language Genie builds side by side (PHP) ALSO installs as the system's package, as one more
 * install source beside Genie's own build, said plainly as the system copy. Its card is the system copy's card while
 * Genie manages no version of it, so the card carries the scan row's name (`data-tool`), its Install, and its refusal.
 */
const t = (tool: string, installed: string | null, tone: 'up-to-date' | 'not-installed' | 'unknown', latest: string | null = null) => ({ tool, installed, latest, tone, source: null });
const defaults = { php: null, node: null, go: null, python: null, dotnet: null, rust: null, ruby: null, java: null };
const missingPhp = {
    tools: [t('php', null, 'not-installed'), t('git', '2.56.0', 'up-to-date', '2.56.0')],
    checkedAt: 1,
    php: { managed: [], system: null, available: [{ version: '8.5.12', installed: false }] },
    installs: { php: { label: 'pacman -S --needed --noconfirm php (as administrator)', elevated: true } },
    defaults,
} as unknown as FeatureData['toolchain'];
const render = (toolchain: FeatureData['toolchain']) => renderToStaticMarkup(<ToolchainSurface data={{ ...EMPTY_FEATURES, toolchain }} onAction={() => {}} onNavigate={() => {}} />);
/** The card's own markup: from its <li> to the next card. */
const card = (html: string, key: string) => { const at = html.indexOf(`data-tool-card="${key}"`); return html.slice(at, html.indexOf('data-tool-card=', at + 10)); };

describe('PHP on Arch: the system package beside Genie’s own build', () => {
    it('a missing PHP card offers BOTH: Genie’s build (no password) and the system package (asks once), each said', () => {
        const c = card(render(missingPhp), 'php');
        expect(c).toContain('data-tool="php"');
        expect(c).toMatch(/<button[^>]*data-action="toolchain-install"[^>]*data-install-system="php"[^>]*title="pacman -S --needed --noconfirm php \(as administrator\)"[^>]*>(?:<span[^>]*>)?Install(?:<\/span>)?<\/button>/);
        expect(c).toMatch(/data-install-note="php"[^>]*>system package, asks once</);
        expect(c).toMatch(/data-card-primary="install"[^>]*data-version="8\.5\.12"[^>]*>(?:<span[^>]*>)?Install 8\.5\.12</);
    });

    it('once the system PHP is there, its card is still the system copy (data-tool) and offers no second install', () => {
        const html = render({ ...missingPhp, tools: [t('php', '8.5.12', 'unknown')], php: { managed: [], system: { version: '8.5.12' }, available: [] }, installs: {} } as unknown as FeatureData['toolchain']);
        const c = card(html, 'php');
        expect(c).toContain('data-tool="php"');
        expect(c).not.toContain('data-install-system');
        expect(c).toContain('8.5.12');
    });

    it('a refusal for the system install is said on the card', () => {
        const html = render({ ...missingPhp, refusals: [{ tool: 'php', reason: 'installing php with pacman would also upgrade icu 77.1-1 → 78.1-1' }] } as unknown as FeatureData['toolchain']);
        expect(card(html, 'php')).toMatch(/data-tool-refusal="php"[^>]*>installing php with pacman would also upgrade icu/);
    });

    it('CONTROL: with a Genie-managed version the card is the language’s, not a system row, and offers no system install', () => {
        const html = render({ ...missingPhp, php: { managed: [{ version: '8.5.11', dir: '/x' }], system: null, available: [{ version: '8.5.12', installed: false }] } } as unknown as FeatureData['toolchain']);
        const c = card(html, 'php');
        expect(c).not.toContain('data-tool="php"');
        expect(c).not.toContain('data-install-system');
    });

    it('CONTROL: with no system install to offer (no preview), there is no system Install', () => {
        expect(card(render({ ...missingPhp, installs: {} } as unknown as FeatureData['toolchain']), 'php')).not.toContain('data-install-system');
    });
});
