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

/**
 * ArtBoard registers the SECOND vetted adapter.
 *
 * The registry is the whole security boundary for the panel surface: a plugin
 * declares a `fancyComponent.export` string and Genie resolves it HERE to an
 * adapter it compiled in. A plugin that names anything else gets an inert
 * placeholder, which is what stops a third party mounting code in Genie's
 * renderer.
 *
 * So the registration is worth a test of its own: an adapter that exists but is
 * not registered is a panel nothing can open, and a panel that renders without a
 * registry entry would mean the boundary had been bypassed.
 */
describe('the ArtBoard adapter', () => {
    it('resolves the declared export', () => {
        expect(panelAdapterKind('ArtBoardPanel')).toBe('artboard');
    });

    it('still fails closed for anything unvetted', () => {
        // Positive control for the case above — without it, "ArtBoard resolves"
        // would pass just as happily against a registry that resolved EVERY
        // string to something.
        expect(panelAdapterKind('ArtBoardPanelEvil')).toBeNull();
        expect(panelAdapterKind('../ArtBoardPanel')).toBeNull();
        expect(panelAdapterKind('')).toBeNull();
    });
});
