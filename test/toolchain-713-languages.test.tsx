import { Children, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ToolCardView, ToolchainSurface } from '../src/renderer/components/FeatureSurfaces.js';
import { toolchainCards } from '../src/renderer/toolchain-view.js';
import { EMPTY_FEATURES, type FeatureAction, type FeatureData } from '../src/renderer/features.js';

/**
 * Tynn #713 — Settings → Toolchain: a language Genie installs side by side (PHP, Node, Python, Java) is its own section —
 * its installed versions as chips, the default marked, a patch update PER installed version, an Install per version not
 * here, Remove for an unused one — and is NOT also a single-version row ("Update to 8.5.12" would replace the version a
 * workspace is pinned to). The single-version list keeps go, rustc, git, docker, composer, npm and the agent CLIs.
 */
const t = (tool: string, installed: string | null, tone: 'up-to-date' | 'update-available' | 'unknown', latest: string | null = null) => ({ tool, installed, latest, tone, source: null });
const tools = [
    t('php', '8.4.24', 'update-available', '8.5.12'), t('node', '22.23.2', 'update-available', '24.22.1'), t('python', '3.13.1', 'unknown'),
    t('go', '1.25.6', 'unknown'), t('rustc', '1.90.0', 'up-to-date'), t('git', '2.56.0', 'unknown'), t('composer', '2.10.2', 'unknown'), t('npm', '11.1.0', 'unknown'), t('claude-code', '2.1.301', 'unknown'),
];
const php = {
    managed: [
        { version: '8.4.24', dir: 'C:/x/8.4.24', usedBy: ['shop.gen'] },
        { version: '8.5.11', dir: 'C:/x/8.5.11', usedBy: [] },
    ],
    system: null,
    available: [{ version: '8.5.12', installed: false }, { version: '8.4.27', installed: false }, { version: '8.3.36', installed: false }],
};
const node = { managed: [{ version: '22.23.2', dir: 'C:/n/22.23.2' }], system: null, available: [{ version: '22.24.0', installed: false }, { version: '24.22.1', installed: false }] };
const python = { managed: [{ version: '3.13.1', dir: 'C:/p/3.13.1' }], system: null, available: [{ version: '3.13.2', installed: false }] };
const full = { tools, checkedAt: 1, php, node, python, defaults: { php: '8.4.24', node: '22.23.2', go: null, python: '3.13.1', dotnet: null, rust: null, ruby: null, java: null } } as unknown as FeatureData['toolchain'];
const render = (toolchain: FeatureData['toolchain'], selected?: string) => renderToStaticMarkup(<ToolchainSurface data={{ ...EMPTY_FEATURES, toolchain }} onAction={() => {}} onNavigate={() => {}} {...(selected ? { selected } : {})} />);
/** The open side panel's markup (Tynn #962): a language's versions are drawn there, for the card that is chosen. */
const panel = (html: string) => html.slice(html.indexOf('data-toolchain-panel='));

function elements(node: ReactNode): ReactElement<Record<string, unknown>>[] {
    const out: ReactElement<Record<string, unknown>>[] = [];
    const walk = (n: ReactNode) => Children.forEach(n, (c) => {
        if (!isValidElement(c)) return;
        out.push(c as ReactElement<Record<string, unknown>>);
        walk((c.props as { children?: ReactNode }).children);
    });
    walk(node);
    return out;
}

describe('#713 — the single-version list keeps only single-version tools', () => {
    it('php, node and python have no row there; go, rustc, git, composer, npm and the agent CLI do (COUNTED: six rows)', () => {
        const html = render(full);
        for (const gone of ['php', 'node', 'python']) expect(html, gone).not.toContain(`data-tool="${gone}"`);
        const rows = [...html.matchAll(/ data-tool="([a-z-]+)"/g)].map((m) => m[1]);
        expect(rows.sort()).toEqual(['claude-code', 'composer', 'git', 'go', 'npm', 'rustc']);
    });

    it('no "Update to 8.5.12" / "Update to 24.22.1" anywhere: a language is never replaced by one button', () => {
        const html = render(full);
        expect(html).not.toMatch(/Update to 8\.5\.12/);
        expect(html).not.toMatch(/Update to 24\.22\.1/);
    });

    it('CONTROL: with no view for a language (nothing known of its versions) its row is still there', () => {
        expect(render({ tools, checkedAt: 1 } as FeatureData['toolchain'])).toContain('data-tool="php"');
    });
});

describe('#713 — the section: chips, the default, a patch per installed version', () => {
    it('each installed version is a chip, the default one marked; the other is not', () => {
        const html = render(full);
        expect(html).toMatch(/data-version-chip="php:8\.4\.24"[^>]*data-default="true"/);
        expect(html).toMatch(/data-version-chip="php:8\.5\.11"[^>]*data-default="false"/);
        expect(html).toMatch(/data-version-chip="node:22\.23\.2"[^>]*data-default="true"/);
        expect(html).toMatch(/data-version-chip="python:3\.13\.1"[^>]*data-default="true"/);
    });

    // Tynn #962: the patch per installed version is on that version's row in the language's PANEL; the card offers the
    // default's patch as its one primary.
    it('a patch update per installed version, inside its own line: 8.4.24 to 8.4.27, 8.5.11 to 8.5.12 (not 8.5.12 for the 8.4)', () => {
        const php = panel(render(full, 'php'));
        expect(php).toMatch(/data-patch-update="php:8\.4\.24"[^>]*data-version="8\.4\.27"/);
        expect(php).toMatch(/data-patch-update="php:8\.5\.11"[^>]*data-version="8\.5\.12"/);
        expect((php.match(/data-patch-update=/g) ?? [])).toHaveLength(2);
        expect(panel(render(full, 'node'))).toMatch(/data-patch-update="node:22\.23\.2"[^>]*data-version="22\.24\.0"/);
        expect(panel(render(full, 'python'))).toMatch(/data-patch-update="python:3\.13\.1"[^>]*data-version="3\.13\.2"/);
        expect(render(full)).toMatch(/data-tool-card="php"[^]*?data-card-primary="patch"[^>]*data-version="8\.4\.27"/);
    });

    it('CONTROL: a version already at its line’s newest has no patch button', () => {
        const html = render({ ...(full as object), php: { ...php, available: [{ version: '8.4.24', installed: true }] } } as unknown as FeatureData['toolchain'], 'php');
        expect(html).toContain('data-toolchain-panel="php"');
        expect(html).not.toContain('data-patch-update="php:8.4.24"');
    });

    it('the patch is an Install beside the old one — it never switches the default: the click is installPhp for that version', () => {
        const sent: FeatureAction[] = [];
        const card = toolchainCards(full!).flatMap((g) => g.cards).find((c) => c.key === 'php')!;
        const view = ToolCardView({ card, selected: false, busy: false, updating: null, updated: null, refusal: null, check: undefined, install: undefined, progress: null, onSelect: () => {}, onAction: (a: FeatureAction) => { sent.push(a); } });
        const button = elements(view).find((e) => e.props['data-card-primary'] === 'patch');
        expect(button).toBeDefined();
        (button!.props['onClick'] as () => void)();
        expect(sent).toEqual([{ kind: 'toolchain.installPhp', version: '8.4.27', consent: true }]);
    });

    // Install another version (Tynn #962): every version not here is a choice in one select, beside one Install.
    it('Install per version not here, and Remove for an unused one, are still there', () => {
        const html = panel(render(full, 'php'));
        for (const v of ['8.5.12', '8.4.27', '8.3.36']) expect(html).toContain(`<option value="${v}"`);
        expect(html).toContain('data-php-install="8.5.12"');
        expect(html).toMatch(/data-php-version="8\.5\.11"[^]*?>Remove</);
    });
});
