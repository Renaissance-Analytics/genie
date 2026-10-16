import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ToolchainSurface } from '../src/renderer/components/FeatureSurfaces.js';
import { EMPTY_FEATURES, toolchainRefusalOf, type FeatureData } from '../src/renderer/features.js';

/**
 * THE TOOLCHAIN SURFACE — what a person sees for T1–T3: a first-run line naming what is missing, each missing tool's
 * exact install command beside its Install button (the click is the consent), Check and repair with a line per
 * finding and its measured result, the progress line while something runs, and Docker's warning with "Update anyway".
 */

const render = (toolchain: FeatureData['toolchain']) => renderToStaticMarkup(<ToolchainSurface data={{ ...EMPTY_FEATURES, toolchain }} onAction={() => {}} onNavigate={() => {}} />);

const base = {
    tools: [
        { tool: 'node', installed: '22.23.2', latest: '22.24.0', tone: 'update-available' as const, source: 'nodejs.org index (LTS)' },
        { tool: 'php', installed: null, latest: null, tone: 'not-installed' as const, source: null },
        { tool: 'rustc', installed: null, latest: null, tone: 'not-installed' as const, source: null },
    ],
    checkedAt: 1,
};

describe('Toolchain', () => {
    it('first run: names what is missing; each missing row shows its command and Install, or why it cannot', () => {
        const html = render({ ...base, installs: { php: { label: 'winget install --id PHP.PHP.8.4 -e --silent', elevated: false }, rustc: { refused: 'rustc is installed with rustup (rustup.rs)' } } });
        expect(html).toContain('data-toolchain-missing="2"');
        expect(html).toMatch(/Not on this machine yet: php, rustc/);
        expect(html).toContain('data-install-command="php"');
        expect(html).toMatch(/winget install --id PHP\.PHP\.8\.4/);
        expect(html).toContain('data-install-refused="rustc"');
        expect(html).toMatch(/Check and repair/);
        // Control: nothing missing → no first-run line.
        expect(render({ ...base, tools: base.tools.slice(0, 1) })).not.toContain('data-toolchain-missing');
    });

    it('a repair’s findings, each with its result; a needs-install finding offers Install', () => {
        const html = render({
            ...base,
            findings: [
                { kind: 'path-shadow', tool: 'php', first: { path: 'C:\\Herd\\bin\\php.exe', version: '8.3.4' }, newer: { path: 'C:\\WinGet\\Links\\php.exe', version: '8.4.13' }, result: { kind: 'repaired', detail: 'Genie now runs php 8.4.13.' } },
                { kind: 'vc-runtime', missing: ['msvcp140.dll'], result: { kind: 'needs-install', tool: 'vcredist', reason: 'PHP cannot start without msvcp140.dll.' } },
            ],
            result: '2 problems found, 1 repaired.',
        });
        expect(html).toContain('data-toolchain-findings="2"');
        expect(html).toMatch(/data-finding="path-shadow" data-result="repaired"/);
        expect(html).toMatch(/data-finding="vc-runtime" data-result="needs-install"/);
        expect(html).toMatch(/2 problems found, 1 repaired\./);
    });

    it('while something runs: the progress line, and the buttons are disabled; Docker’s warning offers Update anyway', () => {
        const busy = render({ ...base, busy: 'Installing php: winget install --id PHP.PHP.8.4' });
        expect(busy).toContain('data-toolchain-busy');
        expect(busy).toMatch(/<button[^>]*disabled=""[^>]*>Check and repair/);
        const warned = render({ ...base, warning: { tool: 'docker', reason: 'Updating Docker restarts its engine, which stops genie-svc-postgres.', affected: ['genie-svc-postgres'] } });
        expect(warned).toContain('data-toolchain-warning="docker"');
        expect(warned).toMatch(/Update anyway/);
    });
});

describe('Toolchain — a refused or failed action is said on the row it was for', () => {
    const reason = 'claude-code is in use by atlas (Claude Code); stop atlas, then update';
    const rows = {
        ...base,
        tools: [
            { tool: 'claude-code', installed: '2.1.0', latest: '2.2.0', tone: 'update-available' as const, source: 'npm registry' },
            ...base.tools,
        ],
    };
    const count = (html: string, needle: string) => html.split(needle).length - 1;
    const rowOf = (html: string, tool: string) => {
        const start = html.indexOf(`data-tool="${tool}"`);
        const end = html.indexOf('</li>', start);
        return html.slice(start, end);
    };

    it('the refusal is drawn INSIDE claude-code’s row, verbatim — exactly one refusal line on the surface', () => {
        const html = render({ ...rows, refusals: [{ tool: 'claude-code', reason }] });
        expect(count(html, 'data-tool-refusal=')).toBe(1);
        expect(rowOf(html, 'claude-code')).toContain('data-tool-refusal="claude-code"');
        expect(rowOf(html, 'claude-code')).toContain(reason);
        // Control: the other rows show none.
        for (const t of ['node', 'php', 'rustc']) expect(rowOf(html, t)).not.toContain('data-tool-refusal');
    });

    it('CONTROL: no refusals → no refusal line anywhere', () => {
        expect(count(render(rows), 'data-tool-refusal=')).toBe(0);
    });

    it('two refusals land on their own two rows', () => {
        const html = render({ ...rows, refusals: [{ tool: 'claude-code', reason }, { tool: 'node', reason: 'node is in use by shop.gen dev server' }] });
        expect(count(html, 'data-tool-refusal=')).toBe(2);
        expect(rowOf(html, 'node')).toContain('node is in use by shop.gen dev server');
        expect(rowOf(html, 'claude-code')).not.toContain('shop.gen');
    });

    it('a refusal for a tool with no row (a prerequisite such as vcredist) is still said, once, not dropped', () => {
        const html = render({ ...rows, refusals: [{ tool: 'vcredist', reason: 'Genie installs nothing without your go-ahead; vcredist was not installed' }] });
        expect(count(html, 'data-tool-refusal="vcredist"')).toBe(1);
        expect(html).toContain('vcredist was not installed');
    });

    it('a PHP version’s refusal is said in PHP versions, not on a tool row', () => {
        const php = { managed: [{ version: '8.4.26', dir: 'C:\\genie2-toolchain\\php-versions\\8.4.26', usedBy: ['shop.gen'] }], system: null, available: [] };
        const html = render({ ...rows, php, refusals: [{ tool: 'php', version: '8.4.26', reason: 'PHP 8.4.26 is pinned by shop.gen' }] });
        expect(count(html, 'data-php-refusal="8.4.26"')).toBe(1);
        expect(html).toContain('PHP 8.4.26 is pinned by shop.gen');
        expect(count(html, 'data-tool-refusal=')).toBe(0);
    });
});

describe('toolchainRefusalOf — the console line the renderer keeps', () => {
    const data = (refusals: NonNullable<FeatureData['toolchain']>['refusals']): FeatureData => ({ ...EMPTY_FEATURES, toolchain: { ...base, ...(refusals ? { refusals } : {}) } });
    const both = data([{ tool: 'claude-code', reason: 'claude-code is in use by atlas' }, { tool: 'php', version: '8.4.26', reason: 'PHP 8.4.26 is pinned by shop.gen' }]);

    it('names the acted row’s refusal only — never another row’s older one', () => {
        expect(toolchainRefusalOf({ kind: 'toolchain.update', tool: 'claude-code' }, both)?.reason).toBe('claude-code is in use by atlas');
        expect(toolchainRefusalOf({ kind: 'toolchain.removePhp', version: '8.4.26' }, both)?.reason).toBe('PHP 8.4.26 is pinned by shop.gen');
        // Control: node's action, which was not refused, logs nothing, though claude-code's refusal is still on screen.
        expect(toolchainRefusalOf({ kind: 'toolchain.update', tool: 'node' }, both)).toBeNull();
        expect(toolchainRefusalOf({ kind: 'toolchain.check' }, both)).toBeNull();
        expect(toolchainRefusalOf({ kind: 'toolchain.update', tool: 'claude-code' }, data(undefined))).toBeNull();
    });
});
