import { describe, expect, it } from 'vitest';
import { panelAdapterKind } from '../plugin-panel-adapters';

/**
 * The COMPILE-TIME panel adapter registry key resolver. The renderer can't
 * dynamically import an arbitrary declared package, so a plugin's declared
 * `fancyComponent.export` is resolved to a KNOWN first-party adapter kind here —
 * an unknown export returns null (fail-closed), and the body renders an inert
 * "needs a newer Genie" placeholder rather than running anything.
 */
describe('panelAdapterKind', () => {
    it('resolves the vetted repo changes panel', () => {
        expect(panelAdapterKind('RepoChangesPanel')).toBe('repo-changes');
    });

    it('is null for an unknown / unvetted export (fail-closed)', () => {
        expect(panelAdapterKind('EvilPanel')).toBeNull();
        expect(panelAdapterKind('')).toBeNull();
        expect(panelAdapterKind('DiffViewer')).toBeNull();
    });
});
