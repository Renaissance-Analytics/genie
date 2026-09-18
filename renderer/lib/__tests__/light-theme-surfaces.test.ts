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
