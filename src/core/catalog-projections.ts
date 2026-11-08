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

/** The editors, in catalog order (Genie's own first), as the window's router takes them (core/plugin-editors.ts `editorFor`). */
export function catalogEditors(defs: readonly ElementDefinition[]): ClaimingEditor[] {
    return defs.filter((d) => d.kind === 'editor').map((d) => ({
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
    return defs.filter((d) => d.kind === 'panel').map((d) => ({
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
