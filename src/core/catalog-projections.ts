import type { ElementDefinition } from './catalog.js';
import type { ClaimingEditor, VettedFancyEditor } from './plugin-editors.js';
import type { VettedFancyExport } from './plugin-panels.js';

/**
 * WHAT IS OFFERED IS THE CATALOG'S (ADF A5, Tynn #449) — pure, renderer-safe. Each projection is the catalog's elements of
 * one kind, shaped as its consumer reads them: the editors a window routes files to, the panels a workspace offers, the
 * steps the flow palette offers and the runner executes. No list kept beside the catalog decides any of these, so an
 * element that leaves the catalog (its package disabled, removed or refused) leaves every projection at once.
 */

/** A definition's own id within its package (`ai.genie.spreadsheet.sheet` → `sheet`). */
const localId = (d: ElementDefinition) => (d.id.startsWith(`${d.packageId}.`) ? d.id.slice(d.packageId.length + 1) : d.id);
const pluginName = (d: ElementDefinition) => (typeof d.payload.pluginName === 'string' ? d.payload.pluginName : d.packageId);
const str = (v: unknown, fallback: string) => (typeof v === 'string' && v !== '' ? v : fallback);

/** Drawn by a client: `client`, or `both` with its link (the owner's ruling q_d71981d6). Host-only elements never reach a window. */
const onAClient = (d: ElementDefinition) => (d.reach.side as string) !== 'host';

/** The editors, in catalog order (Genie's own first), as the window's router takes them (core/plugin-editors.ts `editorFor`). */
export function catalogEditors(defs: readonly ElementDefinition[]): ClaimingEditor[] {
    return defs.filter((d) => d.kind === 'editor' && onAClient(d)).map((d) => ({
        id: localId(d),
        title: str(d.payload.title, d.docs.name),
        extensions: Array.isArray(d.payload.extensions) ? (d.payload.extensions as string[]) : [],
        fancyEditor: { export: String(d.payload.fancyEditor) as VettedFancyEditor },
        pluginId: d.packageId,
        pluginName: pluginName(d),
    }));
}

/** The panels a workspace offers (`+plugin`), as the window draws them. */
export function catalogPanels(defs: readonly ElementDefinition[]): Array<{ pluginId: string; pluginName: string; id: string; title: string; fancyComponent: { export: VettedFancyExport }; props: Readonly<Record<string, unknown>> }> {
    return defs.filter((d) => d.kind === 'panel' && onAClient(d)).map((d) => ({
        pluginId: d.packageId,
        pluginName: pluginName(d),
        id: localId(d),
        title: str(d.payload.title, d.docs.name),
        fancyComponent: { export: String(d.payload.fancyComponent) as VettedFancyExport },
        props: (d.payload.props && typeof d.payload.props === 'object' ? d.payload.props : {}) as Readonly<Record<string, unknown>>,
    }));
}

/** The step kinds the flow palette offers and the runner executes: every flow-node element's executor. */
export function catalogFlowKinds(defs: readonly ElementDefinition[]): string[] {
    return defs.filter((d) => d.kind === 'flow-node' && typeof d.payload.executor === 'string').map((d) => d.payload.executor as string);
}

/** Genie's tools a flow may call: the flow-node elements that name one. */
export function catalogFlowTools(defs: readonly ElementDefinition[]): string[] {
    return defs.filter((d) => d.kind === 'flow-node' && typeof d.payload.tool === 'string').map((d) => d.payload.tool as string);
}

/**
 * AN OPEN PANE, AS ITS PACKAGE IS NOW (ADF A6, Tynn #450): available while the catalog offers its panel; otherwise
 * unavailable with the reason — the package turned off, not installed any more, or no longer offering this panel. A pane
 * is never drawn from a panel its package does not offer.
 */
export function pluginPaneState(
    panels: readonly { readonly pluginId: string; readonly id: string }[],
    entries: readonly { readonly id: string; readonly name: string; readonly state: string }[],
    pluginId: string,
    panelId: string,
): { available: true } | { available: false; reason: string } {
    if (panels.some((p) => p.pluginId === pluginId && p.id === panelId)) return { available: true };
    const entry = entries.find((e) => e.id === pluginId);
    if (!entry) return { available: false, reason: `${pluginId} is not installed any more: close this pane.` };
    if (entry.state !== 'enabled') return { available: false, reason: `${entry.name} is turned off: turn it on in Settings, Plugins, or close this pane.` };
    return { available: false, reason: `${entry.name} no longer offers this panel (${panelId}): close this pane.` };
}
