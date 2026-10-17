import { Icon } from '@particle-academy/react-fancy';
import { useState, type ReactNode } from 'react';
import { LAYOUTS, PANEL_KINDS, type LayoutId, type Panel, type PanelKind, type WorkspaceTab } from '../../core/workspace-tabs.js';

/**
 * A TAB YOU DESIGNED (Tynn story #282): its grid, a cell per panel. The owner, 2026-10-17: "New tabs open to a panel
 * designer that lets me choose my grid layout and add panels to the grid. Panels can be any kind of content from
 * terminals, file browser, genie site, artboards, and dashboard widgets."
 *
 * The designer is ON the tab, not a separate mode: the grid picker, rename and remove sit in its bar, an empty cell
 * offers every panel kind, and a placed panel can be cleared — so a tab is built where it is used. What a panel SHOWS
 * comes from the workspace (`renderPanel`): the terminals, the file panel, a site, the ArtBoard, the agents board.
 */

/** A layout's named areas in cell order (`"a b" "a c"` → a, b, c); none for a plain grid. */
function areaNames(areas: string | undefined): string[] {
    return areas ? [...new Set(areas.match(/[a-z]/g) ?? [])] : [];
}

const KIND_LABEL: Record<PanelKind, string> = { terminal: 'Terminals', files: 'Files', site: 'Genie site', artboard: 'Artboard', widget: 'Agents board' };
const KIND_ICON: Record<PanelKind, string> = { terminal: 'square-terminal', files: 'folder-tree', site: 'globe', artboard: 'layout-list', widget: 'layout-list' };

export interface DesignedTabProps {
    readonly tab: WorkspaceTab;
    readonly renderPanel: (panel: Panel) => ReactNode;
    readonly onLayout: (layout: LayoutId) => void;
    readonly onPlace: (cell: number, panel: Panel) => void;
    readonly onClear: (cell: number) => void;
    readonly onRename: (name: string) => void;
    readonly onRemove: () => void;
    /** What a smaller grid could not keep, said where it happened. */
    readonly notice?: string | null | undefined;
}

export function DesignedTab({ tab, renderPanel, onLayout, onPlace, onClear, onRename, onRemove, notice }: DesignedTabProps) {
    const layout = LAYOUTS.find((l) => l.id === tab.layout) ?? LAYOUTS[0]!;
    const [naming, setNaming] = useState<string | null>(null);
    const areas = areaNames(layout.areas);
    return (
        <div data-designed-tab={tab.id} className="flex min-h-0 flex-1 flex-col">
            <div data-designer-bar="" className="flex h-9 shrink-0 items-center gap-2 border-b border-[var(--border-1)] bg-[var(--bg-1)] px-3 text-[12px]">
                {naming === null ? (
                    <button type="button" data-action="rename-tab" title="Rename this tab" onClick={() => setNaming(tab.name)} className="font-medium hover:underline">{tab.name}</button>
                ) : (
                    <input
                        autoFocus
                        data-tab-name=""
                        value={naming}
                        onChange={(e) => setNaming(e.target.value)}
                        onKeyDown={(e) => { if (e.key === 'Enter') { onRename(naming); setNaming(null); } if (e.key === 'Escape') setNaming(null); }}
                        onBlur={() => { onRename(naming); setNaming(null); }}
                        className="rounded border border-[var(--border-1)] bg-transparent px-1.5 py-0.5"
                    />
                )}
                <span className="text-[var(--fg-4)]">·</span>
                <span className="text-[var(--fg-3)]">Layout</span>
                <div className="flex items-center gap-0.5">
                    {LAYOUTS.map((l) => (
                        <button
                            key={l.id}
                            type="button"
                            data-layout-option={l.id}
                            {...(l.id === tab.layout ? { 'data-current': 'true' } : {})}
                            aria-label={l.label}
                            title={l.label}
                            onClick={() => onLayout(l.id)}
                            className={`grid h-5 w-7 gap-px rounded-sm border p-px ${l.id === tab.layout ? 'border-[var(--fg-2)] bg-[var(--bg-3)]' : 'border-[var(--border-2)] hover:bg-[var(--bg-2)]'}`}
                            style={{ gridTemplateColumns: l.columns, gridTemplateRows: l.rows, ...(l.areas ? { gridTemplateAreas: l.areas } : {}) }}
                        >
                            {Array.from({ length: l.cells }, (_, i) => (
                                <span key={i} className="rounded-[1px] bg-[var(--fg-4)]/40" style={l.areas ? { gridArea: areaNames(l.areas)[i] } : undefined} />
                            ))}
                        </button>
                    ))}
                </div>
                {notice ? <span data-designer-notice="" className="text-[var(--warning)]">{notice}</span> : null}
                <button type="button" data-action="remove-tab" onClick={onRemove} title="Remove this tab (its panels go with it; nothing they show is touched)" className="ml-auto rounded-md px-2 py-0.5 text-[var(--fg-3)] hover:bg-[var(--bg-2)]">Remove tab</button>
            </div>
            <div
                data-layout={tab.layout}
                className="grid min-h-0 flex-1 gap-px bg-[var(--border-1)]"
                style={{ gridTemplateColumns: layout.columns, gridTemplateRows: layout.rows, ...(layout.areas ? { gridTemplateAreas: layout.areas } : {}) }}
            >
                {tab.cells.map((cell, i) => {
                    const area = areas[i];
                    return (
                        <div key={i} data-cell={i} className="flex min-h-0 min-w-0 flex-col bg-[var(--bg-0)]" style={area ? { gridArea: area } : undefined}>
                            {cell === null ? (
                                <div data-empty-cell="" className="flex flex-1 flex-col items-center justify-center gap-2 p-4 text-[12px] text-[var(--fg-3)]">
                                    <span>Add a panel</span>
                                    <div className="flex flex-wrap justify-center gap-1.5">
                                        {PANEL_KINDS.map((k) => (
                                            <button key={k} type="button" data-add-panel={k} onClick={() => onPlace(i, { kind: k, ref: null })} className="flex items-center gap-1.5 rounded-md border border-[var(--border-1)] px-2 py-1 hover:bg-[var(--bg-2)]">
                                                <Icon name={KIND_ICON[k]} size="xs" />
                                                {KIND_LABEL[k]}
                                            </button>
                                        ))}
                                    </div>
                                </div>
                            ) : (
                                <>
                                    <div className="flex h-7 shrink-0 items-center gap-1.5 border-b border-[var(--border-1)] bg-[var(--bg-1)] px-2 text-[11px] text-[var(--fg-3)]">
                                        <Icon name={KIND_ICON[cell.kind]} size="xs" />
                                        <span>{KIND_LABEL[cell.kind]}{cell.ref ? ` · ${cell.ref}` : ''}</span>
                                        <button type="button" data-action="clear-cell" aria-label="Remove this panel" title="Remove this panel" onClick={() => onClear(i)} className="ml-auto rounded px-1 hover:bg-[var(--bg-2)]">✕</button>
                                    </div>
                                    <div data-panel={cell.kind} className="flex min-h-0 flex-1 flex-col overflow-auto">{renderPanel(cell)}</div>
                                </>
                            )}
                        </div>
                    );
                })}
            </div>
        </div>
    );
}
