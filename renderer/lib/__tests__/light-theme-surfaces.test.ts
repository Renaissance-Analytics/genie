import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '../../..');
const read = (relative: string) => fs.readFileSync(path.join(root, relative), 'utf8');
const executable = (source: string) =>
    source
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');

describe('light-theme surface guard', () => {
    it('puts the token-bearing root around every Next page and portal', () => {
        const document = read('renderer/pages/_document.tsx');
        const globals = read('renderer/styles/globals.css');

        expect(document).toContain('<Html className="genie-theme-root">');
        expect(globals).toMatch(/:root\s*\{[\s\S]*--bg-0:/);
        expect(globals).toMatch(/\.dark\s*\{[\s\S]*--bg-0:/);
    });

    it('keeps standalone Docs and Testing Browser chrome on theme tokens', () => {
        const docs = executable(read('renderer/pages/docs.tsx'));
        const browser = executable(read('renderer/pages/testing-browser.tsx'));

        expect(docs).not.toMatch(/#[0-9a-f]{3,8}|rgba?\(/i);
        expect(docs).not.toMatch(/className="prose prose-invert/);
        expect(browser).not.toMatch(/bg-\[#[0-9a-f]{3,8}\]/i);
        expect(browser).not.toMatch(/(?:bg|text|border|ring)-zinc-[0-9]+/);
    });

    it('keeps master menus and host notices off the fixed dark palette', () => {
        const sources = [
            'renderer/pages/master.tsx',
            'renderer/components/Master/HostBuildNudge.tsx',
            'renderer/components/Master/HostUpgradeOverlay.tsx',
        ].map((file) => executable(read(file))).join('\n');

        expect(sources).not.toMatch(
            /#(?:0a0a0c|141418|1b1b21|0f0f13|1a1726|e4e4e7|a1a1aa|71717a|52525b|2a2a33|27272a|3f3f46|c4b5fd)/i,
        );
    });
});

/**
 * THE FILE EDITOR IS NOT A TERMINAL.
 *
 * The owner: "the file editor panel is not light mode friendly", with the whole
 * app light and the Code panel — tree, background and editor — black.
 *
 * The cause is one honest decision applied one surface too far. `--term-*` is
 * FIXED DARK in both themes, deliberately: a terminal is dark whatever the app
 * is, because its colours are the shell's, not Genie's. `.code-host` borrowed
 * that palette because it sits where a terminal sits — and `<CodeEditor>` was
 * handed `theme="dark"` outright, though fancy-code accepts `"light"` too.
 *
 * An editor is a Genie surface. It follows the app.
 */
describe('the code panel follows the app theme', () => {
    const codeHostBlock = (): string => {
        const css = read('renderer/styles/master.css');
        const start = css.indexOf('/* ===== Code view (CodePanel)');
        expect(start, 'the Code view CSS section moved or was renamed').toBeGreaterThan(-1);
        // Up to the next top-level section banner.
        const next = css.indexOf('/* =====', start + 10);
        return css.slice(start, next === -1 ? css.length : next);
    };

    it('paints its chrome from theme tokens, not the fixed terminal palette', () => {
        expect(codeHostBlock()).not.toMatch(/var\(--term-(?:bg|head|fg|border|dim)\)/);
    });

    it('does not pin the editor to the dark theme', () => {
        const panel = executable(read('renderer/components/Code/CodePanel.tsx'));
        expect(panel).not.toMatch(/theme="dark"/);
    });

    it('POSITIVE CONTROL: the TERMINAL keeps the fixed dark palette', () => {
        // Without this, "no --term-* anywhere" would pass against a change that
        // removed the terminal's own colours — which are correct, and are the
        // reason those tokens exist.
        const css = read('renderer/styles/master.css');
        expect(css).toMatch(/\.term-host\s*\{[^}]*var\(--term-bg\)/);
    });
});
