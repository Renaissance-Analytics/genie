/**
 * The COMPILE-TIME plugin-panel adapter registry — the vetting point for the
 * panel surface. The renderer is a webpack bundle and CANNOT dynamically import
 * an arbitrary declared package (owner security rule), so a plugin's declared
 * `fancyComponent.export` is resolved HERE to a known first-party adapter kind.
 * Each adapter is Genie-authored and composes ONLY vetted, Genie-bundled Fancy
 * components; the plugin ships no UI code. An unknown / unvetted export resolves
 * to null so `PluginPanelBody` renders an inert placeholder — a third-party
 * plugin can only ever mount an adapter Genie compiled in.
 *
 * PURE (no React import) so the resolution is unit-testable; the kind → component
 * map with the static imports lives in `PluginPanelBody`.
 */

/** Known panel adapter kinds — one per vetted, Genie-registered adapter. */
export type PanelAdapterKind = 'repo-changes' | 'artboard';

/**
 * Resolve a declared `fancyComponent.export` to a known adapter kind, or null
 * (fail-closed). Two are registered: the Repository Changes panel, and ArtBoard
 * — the review surface an agent posts a mockup or an image to.
 */
export function panelAdapterKind(fancyExport: string): PanelAdapterKind | null {
    switch (fancyExport) {
        case 'RepoChangesPanel':
            return 'repo-changes';
        case 'ArtBoardPanel':
            return 'artboard';
        default:
            return null;
    }
}
