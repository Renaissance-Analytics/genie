/**
 * PLUGIN UI CONTRIBUTIONS (§6.7) — the renderer-safe half of the plugin model.
 *
 * `core/plugins.ts` verifies signatures with `node:crypto`, so the renderer must never import it: a
 * Node built-in in the renderer bundle is a build that does not finish (batch 47, 2026-10-11). The
 * vetted list and the panel shape live here, with no imports at all, and `plugins.ts` re-exports them.
 *
 * A plugin's panel mounts ONLY a vetted Genie-bundled Fancy component — props-mounted components; a
 * compound component like `Table` needs composition a manifest cannot express. No plugin UI code, ever
 * (v1's owner rule, kept).
 */

// `RepoChangesPanel` and `ArtBoardPanel` (beta.33 item 14) are Genie's own first-party panels for the official Repository and
// ArtBoard plugins (Genie 1's compile-time adapter registry): built from Fancy components, still no plugin code.
export const VETTED_FANCY_EXPORTS = ['ContentRenderer', 'JsonEditor', 'Callout', 'RepoChangesPanel', 'ArtBoardPanel'] as const;
export type VettedFancyExport = (typeof VETTED_FANCY_EXPORTS)[number];

/** A panel in the workspace grid mounting one vetted Fancy component with the manifest's props. */
export interface PluginPanel {
    readonly id: string;
    readonly title: string;
    readonly fancyComponent: { readonly export: VettedFancyExport };
    readonly props: Readonly<Record<string, unknown>>;
}
