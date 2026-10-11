import { TreeNav, type TreeNodeData } from '@particle-academy/react-fancy';
import { FileViewer } from '@particle-academy/fancy-code';
import type { Activity, ChangedGroup, FileAttribution, TreeNode } from '../../core/files-panel.js';

/**
 * THE WORKSPACE FILE PANEL (§4.3). ONE per workspace. A 220px tree, tabs, the viewer; a footer naming
 * who is touching what. Attribution is the agents' own report: a touched file carries ONE dot plus a
 * COUNT (violet while an edit is in flight, green when changed this session), a file that changed on
 * disk with no report is neutral with a `?` — Genie does not guess the author. The Changes section is
 * ABSENT when nothing changed. An error renders in the tab body in words, never a blank editor. Before
 * the tree is known: skeletons, not an empty tree. Line counts and per-line presence are never faked.
 */

export interface FilesPanelState {
    readonly files: readonly FileAttribution[];
    readonly activity: readonly Activity[];
    readonly unreported: readonly string[];
    readonly changed: readonly ChangedGroup[] | null;
}

export type OpenFile = { ok: true; path: string; text: string } | { ok: false; path: string; error: string };

export interface FilesPanelProps {
    readonly workspace: { id: string; name?: string | undefined; path: string };
    /** `null` until the host has answered — skeletons, never an empty tree. */
    readonly tree: readonly TreeNode[] | null;
    readonly state: FilesPanelState | null;
    readonly tabs: readonly string[];
    readonly open: OpenFile | null;
    readonly pinned: boolean;
    readonly onSelect: (path: string) => void;
    readonly onCloseTab: (path: string) => void;
    readonly onPin: () => void;
    readonly onClose: () => void;
}

type Tone = 'writing' | 'changed' | 'unreported';

function Marker({ path, count, tone }: { path: string; count: number | null; tone: Tone }) {
    const colour = tone === 'writing' ? 'text-[var(--accent)]' : tone === 'changed' ? 'text-[var(--success)]' : 'text-[var(--fg-4)]';
    return count === null ? (
        <span data-file-marker={path} data-tone={tone} className={`inline-flex items-center gap-0.5 font-mono text-[10px] ${colour}`} title="changed on disk; no agent reported it">?</span>
    ) : (
        <span data-file-marker={path} data-count={count} data-tone={tone} className={`inline-flex items-center gap-0.5 font-mono text-[10px] ${colour}`}>
            ●<span>{count}</span>
        </span>
    );
}

function decorate(nodes: readonly TreeNode[], marks: ReadonlyMap<string, { count: number | null; tone: Tone }>): TreeNodeData[] {
    return nodes.map((n) => {
        const mark = n.type === 'file' ? marks.get(n.id) : undefined;
        return {
            id: n.id,
            label: n.label,
            type: n.type,
            ...(n.ext ? { ext: n.ext } : {}),
            ...(mark ? { icon: <Marker path={n.id} count={mark.count} tone={mark.tone} /> } : {}),
            ...(n.children ? { children: decorate(n.children, marks) } : {}),
        };
    });
}

function marksOf(state: FilesPanelState | null): Map<string, { count: number | null; tone: Tone }> {
    const marks = new Map<string, { count: number | null; tone: Tone }>();
    if (!state) return marks;
    for (const f of state.files) marks.set(f.path, { count: f.count, tone: f.inFlight ? 'writing' : 'changed' });
    for (const p of state.unreported) if (!marks.has(p)) marks.set(p, { count: null, tone: 'unreported' });
    return marks;
}

export function FilesPanel({ workspace, tree, state, tabs, open, pinned, onSelect, onCloseTab, onPin, onClose }: FilesPanelProps) {
    const marks = marksOf(state);
    const touched = new Set<string>([...(state?.files.map((f) => f.path) ?? []), ...(state?.unreported ?? [])]);
    const button = 'rounded-md border border-[var(--border-1)] px-2 py-0.5 text-xs hover:bg-[var(--bg-2)]';
    return (
        <section data-files-panel={workspace.id} className="flex h-full min-h-0 flex-col bg-[var(--bg-0)]">
            <header className="flex h-9 shrink-0 items-center gap-2 border-b border-[var(--border-1)] px-3 text-sm">
                <span className="rounded-md bg-[var(--bg-2)] px-1.5 py-0.5 text-xs font-medium">{workspace.name ?? workspace.id}</span>
                <span className="truncate font-mono text-[11px] text-[var(--fg-4)]">{workspace.path}</span>
                <span className="ml-auto" />
                <button type="button" data-action="pin-files" data-pin={pinned ? 'on' : 'off'} className={button} title={pinned ? 'Pinned: the panel reserves its gutter' : 'Pin the panel'} onClick={onPin}>
                    {pinned ? 'Pinned' : 'Pin'}
                </button>
                <button type="button" data-action="close-files" className={button} title="Close the panel (⌘B)" onClick={onClose}>Close</button>
            </header>
            <div className="flex min-h-0 flex-1">
                <aside className="w-[220px] shrink-0 overflow-auto border-r border-[var(--border-1)] py-1">
                    {tree === null ? (
                        <div data-files-skeleton className="flex flex-col gap-2 px-3 py-2">
                            {Array.from({ length: 6 }, (_, i) => <div key={i} className="h-3 animate-pulse rounded bg-[var(--bg-2)]" style={{ width: `${55 + ((i * 17) % 40)}%` }} />)}
                        </div>
                    ) : (
                        <TreeNav nodes={decorate(tree, marks)} {...(open ? { selectedId: open.path } : {})} onSelect={(id, node) => { if (node.type !== 'folder') onSelect(id); }} defaultExpandAll />
                    )}
                </aside>
                <div className="flex min-w-0 flex-1 flex-col">
                    <div data-file-tabs className="flex h-8 shrink-0 items-stretch border-b border-[var(--border-1)] bg-[var(--bg-1)]">
                        {tabs.map((t) => {
                            const active = open?.path === t;
                            const mark = marks.get(t);
                            return (
                                <div key={t} data-file-tab={t} className={`flex items-center gap-1 border-r border-[var(--border-1)] px-3 text-xs ${active ? 'bg-[var(--bg-0)] text-[var(--fg-1)]' : 'text-[var(--fg-3)]'} ${mark?.tone === 'writing' ? 'shadow-[inset_0_-2px_0_var(--accent)]' : ''}`}>
                                    <button type="button" onClick={() => onSelect(t)} className="font-mono">{t.split('/').pop()}</button>
                                    <button type="button" aria-label={`close ${t}`} onClick={() => onCloseTab(t)} className="text-[var(--fg-4)] hover:text-[var(--fg-1)]">×</button>
                                </div>
                            );
                        })}
                    </div>
                    <div className="min-h-0 flex-1 overflow-auto">
                        {tree === null ? null : open === null ? (
                            <p className="p-4 text-sm text-[var(--fg-3)]">No file open. Pick one in the tree.</p>
                        ) : open.ok ? (
                            <FileViewer filename={open.path} value={open.text} readOnly theme="auto" />
                        ) : (
                            <div data-tab-error className="m-4 rounded-lg border border-[var(--danger)] p-3 text-sm">
                                <p className="font-mono text-xs text-[var(--fg-4)]">{open.path}</p>
                                <p className="mt-1">{open.error}</p>
                            </div>
                        )}
                    </div>
                </div>
            </div>
            {state && (state.activity.length > 0 || touched.size > 0) ? (
                <footer className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-t border-[var(--border-1)] px-3 py-1.5 text-xs text-[var(--fg-2)]">
                    {state.activity.map((a) => (
                        <span key={`${a.agent}:${a.path}`} className="inline-flex items-center gap-1">
                            <span className={a.verb === 'writing' ? 'text-[var(--accent)]' : 'text-[var(--fg-4)]'}>●</span>
                            <span>{`${a.agent} ${a.verb} ${a.path}`}</span>
                        </span>
                    ))}
                    {touched.size > 0 ? <span className="ml-auto">{touched.size} changed in this workspace</span> : null}
                    {state.changed ? (
                        <details data-changes className="basis-full">
                            <summary className="cursor-pointer text-[var(--fg-3)]">Changes ▸</summary>
                            <ul className="mt-1 flex flex-col gap-1">
                                {state.changed.map((g) => (
                                    <li key={g.who} data-changed-by={g.who} className="flex flex-wrap items-baseline gap-2">
                                        <span className={g.who === '?' ? 'text-[var(--fg-4)]' : 'font-medium'}>{g.who}</span>
                                        {g.files.map((f) => <button key={f} type="button" onClick={() => onSelect(f)} className="font-mono text-[11px] text-[var(--fg-3)] hover:text-[var(--fg-1)]">{f}</button>)}
                                    </li>
                                ))}
                            </ul>
                        </details>
                    ) : null}
                </footer>
            ) : null}
        </section>
    );
}
