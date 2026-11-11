import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ToolchainSurface } from '../src/renderer/components/FeatureSurfaces.js';
import { EMPTY_FEATURES, type FeatureData } from '../src/renderer/features.js';

/*
 * Tynn #698 story 1, the wiring. "Is this provider installed" was `providerBinary(...) !== null` in both processes, and
 * providerBinary answers `string | undefined`: always true, so workspace-model's `broken / install-provider` never fired and
 * a switch never refused. Signed in was `() => true`. Both now read the health book (a check that ran the CLI). And the
 * Toolchain row of a broken agent CLI says Broken and why, with no Update button that cannot fix it.
 */
const toolchain = async () => { const path: string = '../src/core/toolchain.js'; return import(path) as Promise<any>; };

/** The file's code, comments stripped line by line (a guard must not be satisfied by a comment). */
function code(file: string): string {
    return readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')
        .split(/\r?\n/)
        .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
        .map((line) => line.replace(/\s\/\/.*$/, ''))
        .join('\n');
}

describe('installed and signed in come from a measurement', () => {
    it.each(['src/main/main.ts', 'src/main/genie-host.ts'])('%s: providerInstalled reads the health book, never providerBinary', (file) => {
        const src = code(file);
        const lines = src.split('\n').filter((l) => /providerInstalled\s*:/.test(l));
        expect(lines.length).toBeGreaterThan(0);
        for (const line of lines) {
            expect(line).not.toMatch(/providerBinary/);
            expect(line).toMatch(/providerHealth\.installed\(/);
        }
    });

    it('the agent-ops wiring asks the book whether a provider is signed in', () => {
        const src = code('src/main/agent-ops-api.ts');
        expect(src).not.toMatch(/signedIn:\s*\(\)\s*=>\s*true/);
        expect(src).toMatch(/signedIn:\s*wiring\.signedIn/);
    });

    it('genie-host checks every provider when it starts', () => {
        expect(code('src/main/genie-host.ts')).toMatch(/providerHealth\.refreshAll\(/);
    });
});

describe('a broken agent CLI on the Toolchain', () => {
    const CLAUDE = { tool: 'claude-code', installed: '2.1.316', latest: '2.1.322', tone: 'update-available', source: 'npm' };
    const CODEX = { tool: 'codex', installed: '0.167.1', latest: '0.167.1', tone: 'up-to-date', source: 'npm' };
    const broken = { provider: 'claude', ok: false, installed: false, signedIn: null, fault: 'placeholder', words: 'Claude Code is installed but cannot run: npm skipped its setup step', version: null, program: 'C:\\npm\\claude.exe', checkedAt: 1 };
    const signedOut = { provider: 'codex', ok: false, installed: true, signedIn: false, fault: 'signed-out', words: 'Codex is not signed in', version: '0.167.1', program: 'x', checkedAt: 1 };

    it('reads Broken, with the reason, whatever its version said', async () => {
        const { withProviderHealth, toneLabel } = await toolchain();
        const [claude, codex] = withProviderHealth([CLAUDE, CODEX], [broken, signedOut]);
        expect(claude).toMatchObject({ tool: 'claude-code', tone: 'broken', problem: broken.words });
        // Signed out is a login matter, not the tool's state: the row stays as measured.
        expect(codex).toEqual(CODEX);
        expect(toneLabel('broken')).toBe('Broken');
    });

    it('offers no Update for a broken row, and says why on it', async () => {
        const { withProviderHealth } = await toolchain();
        const tools = withProviderHealth([CLAUDE], [broken]);
        const html = renderToStaticMarkup(<ToolchainSurface data={{ ...EMPTY_FEATURES, toolchain: { tools, checkedAt: 1 } as FeatureData['toolchain'] }} onAction={() => {}} onNavigate={() => {}} />);
        const row = html.slice(html.indexOf('data-tool="claude-code"'), html.indexOf('</li>', html.indexOf('data-tool="claude-code"')));
        expect(row).toContain('data-tone="broken"');
        expect(row).toContain('Broken');
        expect(row).toContain('npm skipped its setup step');
        expect(row).not.toContain('data-action="toolchain-update"');
    });
});
