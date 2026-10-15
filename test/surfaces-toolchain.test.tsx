import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ToolchainSurface } from '../src/renderer/components/FeatureSurfaces.js';
import { EMPTY_FEATURES, type FeatureData } from '../src/renderer/features.js';

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
