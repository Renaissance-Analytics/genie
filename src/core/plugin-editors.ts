/**
 * PLUGIN EDITORS (§6.7; beta.33 item 14) — the renderer-safe half: which plugin's editor opens a file.
 *
 * A plugin ships no UI code. Its manifest DECLARES an editor: the file types it claims and the first-party Fancy component
 * Genie bundles that edits them (Genie 1's main/plugins/editor-routing.ts + side.ts, kept). The decision is CLIENT-side —
 * it reads the editors of the plugins ENABLED on the Genie you are sitting at — and fail-closed: a disabled, refused or
 * malformed plugin claims nothing, and an unclaimed file keeps the code editor. No Node imports: the renderer routes with it.
 */

/** The Fancy editors Genie bundles. A manifest naming anything else is refused at parse time. */
export const VETTED_FANCY_EDITORS = ['Editor', 'SheetWorkbook', 'DeckEditor'] as const;
export type VettedFancyEditor = (typeof VETTED_FANCY_EDITORS)[number];

/** One editor a manifest declares. Extensions are lower-cased, with their dot. */
export interface PluginEditor {
    readonly id: string;
    readonly title: string;
    readonly extensions: readonly string[];
    readonly fancyEditor: { readonly export: VettedFancyEditor };
}

/** An editor of an ENABLED plugin, with whose it is — what the router chooses from. */
export interface ClaimingEditor extends PluginEditor {
    readonly pluginId: string;
    readonly pluginName: string;
}

/** The lower-cased dotted extension of a path's base name (`.md`), or `''` — a dotfile has none. */
export function pluginFileExtension(path: string): string {
    const base = path.split(/[\\/]/).pop() ?? path;
    const dot = base.lastIndexOf('.');
    return dot > 0 ? base.slice(dot).toLowerCase() : '';
}

/** The first editor that claims the file's extension, or `null` = the code editor. First claim wins. */
export function editorFor(editors: readonly ClaimingEditor[], path: string): ClaimingEditor | null {
    const ext = pluginFileExtension(path);
    if (!ext) return null;
    return editors.find((e) => e.extensions.includes(ext)) ?? null;
}

export type EditorBytesDecision = { allowed: true } | { allowed: false; reason: string };

/**
 * The bytes an editor of THIS plugin may read and write: a type its own editor claims AND its fs capability declares
 * (Genie 1 side.ts `clientEditorExtensions` — tighter than either alone). Anything else is refused, naming which half.
 */
export function editorBytesAccess(manifest: { readonly id: string; readonly editors?: readonly PluginEditor[] | undefined; readonly capabilities: { readonly fs?: { readonly extensions: readonly string[] } | undefined } }, path: string): EditorBytesDecision {
    const ext = pluginFileExtension(path);
    const claimed = ext !== '' && (manifest.editors ?? []).some((e) => e.extensions.includes(ext));
    if (!claimed) return { allowed: false, reason: `no editor of ${manifest.id} opens ${ext || 'extensionless'} files` };
    const declared = (manifest.capabilities.fs?.extensions ?? []).map((e) => e.toLowerCase());
    if (!declared.includes(ext)) return { allowed: false, reason: `${manifest.id} does not declare fs access to ${ext} files; its editor cannot read or save them` };
    return { allowed: true };
}
