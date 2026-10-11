import { describe, expect, it } from 'vitest';
import { VETTED_FANCY_EXPORTS, parseManifest } from '../src/core/plugins.js';

/**
 * PLUGIN UI CONTRIBUTIONS (§6.7, v1's owner rule kept): a plugin may contribute PANELS to a workspace, and a
 * panel mounts ONLY a vetted Genie-bundled Fancy component — no plugin-shipped UI code, ever. The manifest
 * names the component by export; an export not on the vetted list is refused in words at parse time, so an
 * unvetted panel never reaches a renderer.
 */

const base = {
    id: 'acme.lint',
    name: 'Acme Lint',
    version: '1.0.0',
    publisher: { name: 'Acme', keyId: 'acme-1' },
    capabilities: { network: { hosts: [] }, genieApi: [] },
};

describe('manifest panels', () => {
    it('parses a panel that mounts a vetted Fancy export, with its title and props', () => {
        const parsed = parseManifest({ ...base, panels: [{ id: 'report', title: 'Lint report', fancyComponent: { export: 'ContentRenderer' }, props: { value: '# Report' } }] });
        expect(parsed.ok).toBe(true);
        if (!parsed.ok) return;
        expect(parsed.manifest.panels).toEqual([{ id: 'report', title: 'Lint report', fancyComponent: { export: 'ContentRenderer' }, props: { value: '# Report' } }]);
    });

    it('no panels is an empty list, not undefined', () => {
        const parsed = parseManifest(base);
        expect(parsed.ok && parsed.manifest.panels).toEqual([]);
    });

    it('refuses an unvetted export, a missing id or title, an unknown key, and a non-object props', () => {
        const refused = (panels: unknown) => { const r = parseManifest({ ...base, panels }); return r.ok ? null : r.reason; };
        expect(refused([{ id: 'x', title: 'X', fancyComponent: { export: 'Terminal' } }])).toMatch(/not a vetted Fancy component/);
        expect(refused([{ id: 'x', title: 'X', fancyComponent: { export: 'Terminal' } }])).toContain('Terminal');
        expect(refused([{ title: 'X', fancyComponent: { export: 'Callout' } }])).toMatch(/id/);
        expect(refused([{ id: 'x', fancyComponent: { export: 'Callout' } }])).toMatch(/title/);
        expect(refused([{ id: 'x', title: 'X', fancyComponent: { export: 'Callout' }, script: 'evil.js' }])).toMatch(/unknown key "script"/);
        expect(refused([{ id: 'x', title: 'X', fancyComponent: { export: 'Callout' }, props: 'nope' }])).toMatch(/props/);
        expect(refused('nope')).toMatch(/panels must be an array/);
    });

    it('the vetted list is short, explicit and holds only props-mounted components Genie bundles (a compound component like Table needs composition a manifest cannot express)', () => {
        expect([...VETTED_FANCY_EXPORTS].sort()).toEqual(['Callout', 'ContentRenderer', 'JsonEditor'].sort());
    });
});
