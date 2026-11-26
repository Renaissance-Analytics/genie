import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ToolStatus } from '../src/core/toolchain.js';
import { vcRuntimeOutcomeText } from '../src/core/php-versions.js';
import { ensureVcRuntimeAtLeast } from '../src/main/vc-runtime.js';
import { ToolchainSurface } from '../src/renderer/components/FeatureSurfaces.js';
import { EMPTY_FEATURES, type FeatureData } from '../src/renderer/features.js';
import { plainRefusal } from '../src/renderer/toolchain-view.js';

/**
 * Tynn #1066, the coordinator's review of the fresh-Windows shots (2026-11-26):
 * - "Install it (asks for administrator)" was clicked and the card showed NOTHING (the VM's consent.exe failed): every
 *   outcome must be on the card — waiting for approval, declined, failed with why, restart needed, installed;
 * - "System · none on this machine" was a radio row for something that does not exist: no system PHP, no row.
 */
type Tc = NonNullable<FeatureData['toolchain']>;
const t = (tool: string, installed: string | null, tone: ToolStatus['tone']): ToolStatus => ({ tool, installed, latest: null, tone, source: null });

/** A machine whose vcruntime140.dll reads 14.44 throughout, and whose elevated run ends as `end` says. */
function machine(end: { exit?: number; throws?: string }) {
    const run = async (binary: string, args: readonly string[]) => {
        const line = `${binary} ${args.join(' ')}`;
        if (line.includes('Get-AuthenticodeSignature')) return { stdout: 'Valid|CN=Microsoft Corporation, O=Microsoft Corporation, L=Redmond, S=Washington, C=US\r\n', exitCode: 0 };
        if (line.includes('ProductVersion')) return { stdout: '14.52.37029.0\r\n', exitCode: 0 };
        if (line.includes('VersionInfo')) return { stdout: '14.44.35211.0\r\n', exitCode: 0 };
        if (line.includes('Start-Process')) {
            if (end.throws) throw new Error(end.throws);
            return { stdout: '', exitCode: end.exit ?? 0 };
        }
        throw new Error(`unexpected ${line}`);
    };
    return { run, systemRoot: 'C:/Windows', tempDir: 'C:/genie/tmp', download: async () => ({ ok: true as const, body: new Uint8Array([1]) }), writeFile: () => {} };
}

describe('every outcome of the runtime button is named', () => {
    it('declined (1223 / 1602), restart needed (3010), failed (any other exit), no answer (the run gave up)', async () => {
        expect(await ensureVcRuntimeAtLeast('14.50', machine({ exit: 1223 }), { install: true })).toMatchObject({ ok: false, outcome: 'declined' });
        expect(await ensureVcRuntimeAtLeast('14.50', machine({ exit: 3010 }), { install: true })).toMatchObject({ ok: false, outcome: 'restart' });
        expect(await ensureVcRuntimeAtLeast('14.50', machine({ exit: 5 }), { install: true })).toMatchObject({ ok: false, outcome: 'failed' });
        expect(await ensureVcRuntimeAtLeast('14.50', machine({ throws: 'Command timed out after 300000 ms' }), { install: true })).toMatchObject({ ok: false, outcome: 'no-answer' });
    });

    it('in words on the card, each one different', () => {
        const words = (outcome: 'declined' | 'restart' | 'failed' | 'no-answer') => vcRuntimeOutcomeText('8.6.0', { ok: false, outcome, reason: 'why' });
        expect(words('declined')).toBe('The Microsoft Visual C++ runtime was not installed: administrator approval was declined.');
        expect(words('no-answer')).toBe('The Microsoft Visual C++ runtime was not installed: no administrator approval came.');
        expect(words('failed')).toBe('The Microsoft Visual C++ runtime was not installed: why.');
        expect(words('restart')).toBe('The Microsoft Visual C++ runtime is installed. Restart Windows, then install PHP 8.6.0.');
    });

    it('declined and failed keep the button (to try again); restart needs none', () => {
        expect(plainRefusal('The Microsoft Visual C++ runtime was not installed: administrator approval was declined.')).toMatchObject({ vcRuntime: true });
        expect(plainRefusal('The Microsoft Visual C++ runtime is installed. Restart Windows, then install PHP 8.6.0.').vcRuntime).toBeUndefined();
    });
});

const scene = (extra: Partial<Tc>, system: { version: string } | null = null): Tc => ({
    tools: [t('git', '2.52.0', 'up-to-date')],
    checkedAt: 1,
    php: { managed: [{ version: '8.5.13', dir: '/t/8.5.13', usedBy: [] }], system, available: [{ version: '8.6.0', installed: false }] },
    defaults: { php: '8.5.13', node: null, go: null, python: null, dotnet: null, rust: null, ruby: null, java: null },
    ...extra,
});
const render = (tc: Tc) => renderToStaticMarkup(<ToolchainSurface data={{ ...EMPTY_FEATURES, toolchain: tc }} onAction={() => {}} onNavigate={() => {}} selected="php" />);
const aside = (html: string) => html.slice(Math.max(0, html.indexOf('data-toolchain-aside')));

describe('while it runs, the panel says so', () => {
    it('the step Genie is on (waiting for administrator approval) is drawn in the open panel', () => {
        const html = aside(render(scene({ busy: 'Waiting for administrator approval to install the Microsoft Visual C++ runtime 14.52' })));
        expect(html).toMatch(/data-panel-busy="[^"]*"[^>]*>[^]*?Waiting for administrator approval/);
    });
    it('control: with nothing running, no such line', () => {
        expect(aside(render(scene({})))).not.toContain('data-panel-busy');
    });
});

describe('no system PHP, no System row', () => {
    it('with none on this machine, the list has no System row to choose', () => {
        expect(aside(render(scene({})))).not.toContain('data-php-system-row');
    });
    it('control: with a PHP of the person’s own on PATH, the row is there', () => {
        expect(aside(render(scene({}, { version: '8.3.6' })))).toContain('data-php-system-row');
    });
});
