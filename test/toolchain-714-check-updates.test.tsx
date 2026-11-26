import { Children, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ToolchainCheckBar, ToolchainSurface } from '../src/renderer/components/FeatureSurfaces.js';
import { EMPTY_FEATURES, type FeatureAction, type FeatureData } from '../src/renderer/features.js';

/**
 * Tynn #714 — a "Check for updates" button that re-checks every row ONE TOOL AT A TIME, each row showing its own state
 * (waiting, checking, up to date, update available, or failed with its reason). It installs nothing, becomes Stop while it
 * runs, and shows the last-checked time. Opening the page does not scan: it shows the last known results at once.
 */
const t = (tool: string, installed: string, tone: 'up-to-date' | 'update-available' | 'unknown', latest: string | null = null) => ({ tool, installed, latest, tone, source: null });
const tools = [t('git', '2.56.0', 'up-to-date'), t('composer', '2.10.2', 'update-available', '2.11.0'), t('npm', '11.1.0', 'unknown'), t('go', '1.25.6', 'unknown'), t('rustc', '1.90.0', 'unknown')];
const mk = (extra: Record<string, unknown> = {}) => ({ tools, checkedAt: 1_700_000_000_000, ...extra }) as unknown as NonNullable<FeatureData['toolchain']>;
const render = (toolchain: FeatureData['toolchain']) => renderToStaticMarkup(<ToolchainSurface data={{ ...EMPTY_FEATURES, toolchain }} onAction={() => {}} onNavigate={() => {}} />);
const row = (html: string, tool: string) => html.slice(html.indexOf(` data-tool="${tool}"`), html.indexOf('</li>', html.indexOf(` data-tool="${tool}"`)));

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
const press = (tree: ReactNode, attr: string, value: string): void => {
    const button = elements(tree).find((e) => e.props[attr] === value);
    expect(button, `${attr}=${value}`).toBeDefined();
    expect(button!.props['disabled']).toBeFalsy();
    (button!.props['onClick'] as () => void)();
};

const running = { running: true, rows: { git: { state: 'up-to-date' }, composer: { state: 'update-available' }, npm: { state: 'checking' }, go: { state: 'waiting' }, rustc: { state: 'failed', reason: 'rustup did not answer within 20 s' } } };

describe('#714 — the button', () => {
    it('idle: "Check for updates" sends toolchain.checkUpdates; there is no Stop', () => {
        const sent: FeatureAction[] = [];
        const bar = ToolchainCheckBar({ tc: mk(), busy: false, onAction: (a: FeatureAction) => { sent.push(a); } });
        expect(elements(bar).some((e) => e.props['data-action'] === 'toolchain-check-stop')).toBe(false);
        press(bar, 'data-action', 'toolchain-check-updates');
        expect(sent).toEqual([{ kind: 'toolchain.checkUpdates' }]);
        expect(renderToStaticMarkup(<>{bar}</>)).toMatch(/Check for updates/);
    });

    it('while it runs the same place says Stop, and Stop sends toolchain.stopCheck (the check button is gone)', () => {
        const sent: FeatureAction[] = [];
        const bar = ToolchainCheckBar({ tc: mk({ checkRun: running }), busy: false, onAction: (a: FeatureAction) => { sent.push(a); } });
        expect(elements(bar).some((e) => e.props['data-action'] === 'toolchain-check-updates')).toBe(false);
        press(bar, 'data-action', 'toolchain-check-stop');
        expect(sent).toEqual([{ kind: 'toolchain.stopCheck' }]);
        expect(renderToStaticMarkup(<>{bar}</>)).toMatch(/Stop/);
    });

    it('the last-checked time is shown; never checked says so', () => {
        const html = render(mk());
        expect(html).toMatch(/data-toolchain-checked="1700000000000"/);
        expect(html).toMatch(/Checked/);
        expect(render({ ...mk(), checkedAt: null })).toMatch(/Not checked yet/);
    });

    it('the old "Check again" (a whole re-scan, no progress) is gone', () => {
        expect(render(mk())).not.toMatch(/Check again/);
    });
});

describe('#714 — each row shows its own state', () => {
    it('the five states on five rows, each readable (COUNTED: five data-check-state marks, one each)', () => {
        const html = render(mk({ checkRun: running }));
        expect([...html.matchAll(/data-check-state="([a-z-]+)"/g)].map((m) => m[1]).sort()).toEqual(['checking', 'failed', 'up-to-date', 'update-available', 'waiting']);
        expect(row(html, 'git')).toMatch(/data-check-state="up-to-date"/);
        expect(row(html, 'composer')).toMatch(/data-check-state="update-available"/);
        expect(row(html, 'npm')).toMatch(/data-check-state="checking"/);
        expect(row(html, 'go')).toMatch(/data-check-state="waiting"/);
        expect(row(html, 'rustc')).toMatch(/data-check-state="failed"/);
    });

    it('a failed row says WHY, in its own words', () => {
        expect(row(render(mk({ checkRun: running })), 'rustc')).toContain('rustup did not answer within 20 s');
    });

    it('CONTROL: with no run, no row carries a check state; with one, a row it does not list carries none', () => {
        expect(render(mk())).not.toContain('data-check-state');
        const html = render(mk({ checkRun: { running: true, rows: { git: { state: 'checking' } } } }));
        expect(row(html, 'go')).not.toContain('data-check-state');
    });

    it('a check shows nothing to install: no Install/Update button appears because a check ran', () => {
        const idle = render(mk());
        const during = render(mk({ checkRun: running }));
        expect((during.match(/data-action="toolchain-update"/g) ?? []).length).toBe((idle.match(/data-action="toolchain-update"/g) ?? []).length);
    });

    it('a language section carries its own state too (php is checked with the rest)', () => {
        const php = { managed: [{ version: '8.4.24', dir: 'C:/x', usedBy: [] }], system: null, available: [] };
        const html = renderToStaticMarkup(<ToolchainSurface data={{ ...EMPTY_FEATURES, toolchain: mk({ php, tools: [...tools, t("php", "8.4.24", "unknown")], checkRun: { running: true, rows: { php: { state: "checking" } } } }) }} onAction={() => {}} onNavigate={() => {}} selected="php" />);
        expect(html).toMatch(/data-php-versions="1"[^>]*>[^]*?data-check-state="checking"/);
    });
});
