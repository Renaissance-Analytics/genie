import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const CSS = fs.readFileSync(path.resolve(__dirname, '../../styles/master.css'), 'utf8');

describe('AgentPanel context menu', () => {
    it('paints an opaque theme-token surface in light and dark modes', () => {
        const rule = CSS.match(/\.agent-panel-menu\s*\{([^}]*)\}/)?.[1] ?? '';
        expect(rule).toMatch(/background:\s*var\(--(?:bg-0|shell|surface)[^)]*\)/);
        expect(rule).toMatch(/border:/);
        expect(rule).toMatch(/box-shadow:/);
    });
});
