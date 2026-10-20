import { ContextMenu, Icon, TreeNav, type TreeNodeData } from '@particle-academy/react-fancy';
import { useState } from 'react';
import { fileMenuItems, type FileMenuAction, type FileMenuTarget } from '../../core/file-menu.js';
import { CodeEditor, FileViewer, resolveFileKind } from '@particle-academy/fancy-code';
import type { Activity, ChangedGroup, FileAttribution, TreeNode } from '../../core/files-panel.js';
import { fileCrumb, statusBarFor } from '../../core/files-panel.js';
import { FancyDiff } from '@particle-academy/fancy-diff';
import { conflictBody, conflictHunks, conflictWords, takeLabel } from '../../core/conflict-words.js';
import type { Pause } from '../../core/files-popout.js';

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

export type OpenFile = { ok: true; path: string; text: string; sha: string; git?: 'committed' | 'modified' | 'untracked' | null | undefined } | { ok: false; path: string; error: string };

/** Editing (§4.3): the buffer's state and the choices when a save is refused. Absent = read-only viewer. */
export interface FilesEdit {
    readonly dirty: boolean;
    /** `baseline` = the text as it was OPENED (the container's), so the banner can say which lines each side changed. */
    readonly conflict: { path: string; onDisk: string; sha: string; baseline?: string | undefined } | null;
    readonly onChange: (text: string) => void;
    readonly onSave: () => void;
    readonly onKeepMine: () => void;
    readonly onTakeTheirs: () => void;
    /** The agent Genie TOLD about this conflict (and holds paused), or `null` — the banner says so only then. */
    readonly told?: string | null | undefined;
    /** `Compare` is open: your buffer against the disk, in the kit's diff. */
    readonly comparing?: boolean | undefined;
    readonly onCompare?: (() => void) | undefined;
    /** A save that failed WITHOUT a conflict (permission, a full disk, the host gone): its reason, until the next save. */
    readonly saveError?: string | null | undefined;
}

/** Ctrl+S / Cmd+S (Genie 1's CodePanel) — not with Shift (Save As in most editors) or Alt. */
export function isSaveShortcut(e: { key: string; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean }): boolean {
    return (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 's';
}

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
    /** Pin the panel to the side; absent = no Pin (the chat holds the side, 2026-10-19). */
    readonly onPin?: (() => void) | undefined;
    readonly onClose: () => void;
    readonly edit?: FilesEdit | undefined;
    /** Pop the panel into its own window (§4.3); absent on a bridge that cannot open host windows. */
    readonly onPopOut?: (() => void) | undefined;
    /** `Show diff` on the blind banner: ask for the last committed text. Absent = no baseline to offer, no button. */
    readonly onShowDiff?: (() => void) | undefined;
    /** The last commit's text for the open file (`null` = not in the last commit), once asked. */
    readonly blindDiff?: { path: string; before: string | null } | null | undefined;
    /** In its own window: no pin, no pop-out — one control docks it back (`onClose`). */
    readonly popped?: boolean | undefined;
    /** Agents ASKED to pause on a file you have dirty (§4.3) — named in the footer, marked on the tab. */
    readonly paused?: readonly Pause[] | undefined;
    /** SINGLE mode (§4.6 a code pane): one file, no tree, no other tabs. */
    readonly single?: string | undefined;
    /** Open a file as its own pane in the workspace grid (§4.6); absent where panes cannot be made (the dock, a popped window). */
    readonly onOpenInPane?: ((path: string) => void) | undefined;
    /** Right-click a tree row or a tab (Tynn #841): what this window can do, and the container's hand. Absent = no menus. */
    readonly fileActions?: { readonly external: boolean; readonly reveal: boolean; readonly edit?: boolean; readonly onAction: (action: FileMenuAction, path: string, target: FileMenuTarget) => void } | undefined;
    /** The board's `All | Changed N` filter: Changed shows the files grouped by who changed them, in the tree's place. */
    readonly filter?: 'all' | 'changed' | undefined;
    readonly onFilter?: ((filter: 'all' | 'changed') => void) | undefined;
    /** The tree could not be read: the reason, said in the tree's place instead of skeletons that never end. */
    readonly treeError?: string | null | undefined;
    /** The folders open in the tree (controlled; nothing is open at start — core/files-tree-lazy.ts). */
    readonly expanded?: readonly string[] | undefined;
    readonly onExpandedChange?: ((ids: readonly string[]) => void) | undefined;
    /** The line the open file lands on (the route's `line=`, openFileForUser's) — Fancy's FileViewer scrolls to it and highlights it. */
    readonly line?: number | null | undefined;
}

/** How many files changed this session — the `Changed N` chip's number; `0` reads as plain `Changed`. */
function changedCount(state: FilesPanelState | null): number {
    return state?.changed?.reduce((n, g) => n + g.files.length, 0) ?? 0;
}

type Tone = 'writing' | 'changed' | 'unreported';

/** `14:08`, in the viewer's locale — the changed row's time column. */
const hhmm = (at: number) => new Date(at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });

function StatusBar({ path, text, activity, hunks = null }: { path: string; text: string; activity: readonly Activity[]; hunks?: number | null }) {
    const bar = statusBarFor(path, text, activity);
    // In conflict, the board's last segment: `conflict · 1 hunk`, counted from your buffer against the disk.
    const conflict = hunks === null ? '' : ` · conflict · ${hunks} ${hunks === 1 ? 'hunk' : 'hunks'}`;
    return (
        <div data-file-status={path} className="flex shrink-0 items-center border-t border-[var(--border-1)] px-4 py-1 font-mono text-[11px] text-[var(--fg-4)]">
            {`${bar.language} · ${bar.eol} · ${bar.encoding} · ${bar.presence}${conflict}`}
        </div>
    );
}

function Marker({ path, count, tone, names = [] }: { path: string; count: number | null; tone: Tone; names?: readonly string[] | undefined }) {
    const colour = tone === 'writing' ? 'text-[var(--accent)]' : tone === 'changed' ? 'text-[var(--success)]' : 'text-[var(--fg-4)]';
    return count === null ? (
        <span data-file-marker={path} data-tone={tone} className={`inline-flex items-center gap-0.5 font-mono text-[10px] ${colour}`} title="changed on disk; no agent reported it">?</span>
    ) : (
        // ONE dot plus a count, never one dot per agent — hovering names them (the board).
        <span data-file-marker={path} data-count={count} data-tone={tone} {...(names.length > 0 ? { title: names.join(', ') } : {})} className={`inline-flex items-center gap-0.5 font-mono text-[10px] ${colour}`}>
            ●<span>{count}</span>
        </span>
    );
}

function decorate(nodes: readonly TreeNode[], marks: ReadonlyMap<string, { count: number | null; tone: Tone; names: readonly string[] }>): TreeNodeData[] {
    return nodes.map((n) => {
        const mark = n.type === 'file' ? marks.get(n.id) : undefined;
        return {
            id: n.id,
            label: n.label,
            type: n.type,
            ...(n.ext ? { ext: n.ext } : {}),
            ...(mark ? { icon: <Marker path={n.id} count={mark.count} tone={mark.tone} names={mark.names} /> } : {}),
            ...(n.children ? { children: decorate(n.children, marks) } : {}),
        };
    });
}

function marksOf(state: FilesPanelState | null): Map<string, { count: number | null; tone: Tone; names: readonly string[] }> {
    const marks = new Map<string, { count: number | null; tone: Tone; names: readonly string[] }>();
    if (!state) return marks;
    for (const f of state.files) marks.set(f.path, { count: f.count, tone: f.inFlight ? 'writing' : 'changed', names: f.agents.map((a) => a.name) });
    for (const p of state.unreported) if (!marks.has(p)) marks.set(p, { count: null, tone: 'unreported', names: [] });
    return marks;
}

export function FilesPanel({ workspace, tree, state, tabs, open, pinned, onSelect, onCloseTab, onPin, onClose, edit, onPopOut, onShowDiff, blindDiff, popped = false, paused = [], single, onOpenInPane, filter = 'all', onFilter, treeError = null, line = null, expanded, onExpandedChange, fileActions }: FilesPanelProps) {
    // The row or tab right-clicked: the menu's items depend on what it is.
    const [menuFor, setMenuFor] = useState<{ path: string; target: FileMenuTarget } | null>(null);
    const menuItems = (path: string, target: FileMenuTarget) => fileActions ? fileMenuItems(target, fileActions).map((m, i) => (m.id === '-'
        ? <ContextMenu.Separator key={`sep-${i}`} />
        : <ContextMenu.Item key={m.id} onClick={() => fileActions.onAction(m.id as FileMenuAction, path, target)}>{m.label}</ContextMenu.Item>)) : null;
    const marks = marksOf(state);
    const touched = new Set<string>([...(state?.files.map((f) => f.path) ?? []), ...(state?.unreported ?? [])]);
    const button = 'rounded-md border border-[var(--border-1)] px-2 py-0.5 text-xs hover:bg-[var(--bg-2)]';
    // Single mode (§4.6): the one file this pane is about, and nothing else to pick from.
    const shownTabs = single ? tabs.filter((t) => t === single) : tabs;
    const changed = changedCount(state);
    return (
        <section data-files-panel={workspace.id} {...(single ? { 'data-single': single } : {})} className="flex h-full min-h-0 flex-col bg-[var(--bg-0)]"
            onKeyDown={(e) => { if (isSaveShortcut(e) && edit && open?.ok) { e.preventDefault(); if (edit.dirty && !edit.conflict) edit.onSave(); } }}>
            {/* The board's 38px header: Files · All | Changed N · "one per workspace" · the controls. */}
            <header className="flex h-[38px] shrink-0 items-center gap-2.5 border-b border-[var(--border-1)] bg-[var(--bg-1)] px-3 text-sm">
                <span className="text-xs font-semibold">Files</span>
                {single ? null : (
                    <div className="flex overflow-hidden rounded-md border border-[var(--border-1)] text-[11px]">
                        <button type="button" data-files-filter="all" {...(filter === 'all' ? { 'data-current': 'true' } : {})} onClick={() => onFilter?.('all')} className={`px-2 py-0.5 ${filter === 'all' ? 'bg-[var(--bg-3)] text-[var(--fg-1)]' : 'text-[var(--fg-2)] hover:bg-[var(--bg-2)]'}`}>All</button>
                        {/* `data-changes` while there ARE changes — the chip is the door the footer's fold used to be. */}
                        <button type="button" data-files-filter="changed" {...(filter === 'changed' ? { 'data-current': 'true' } : {})} {...(changed > 0 ? { 'data-changes': '' } : {})} onClick={() => onFilter?.('changed')} className={`border-l border-[var(--border-1)] px-2 py-0.5 ${filter === 'changed' ? 'bg-[var(--bg-3)] text-[var(--fg-1)]' : 'text-[var(--fg-2)] hover:bg-[var(--bg-2)]'}`}>{changed > 0 ? `Changed ${changed}` : 'Changed'}</button>
                    </div>
                )}
                <span className="truncate font-mono text-[11px] text-[var(--fg-4)]">{workspace.name ?? workspace.id} · {workspace.path}</span>
                <span className="ml-auto" />
                {single ? null : <span className="text-[11px] text-[var(--fg-4)]">one per workspace</span>}
                {popped ? (
                    <button type="button" data-action="bring-back-files" className={button} title="Dock the panel back into the main window" onClick={onClose}>Dock it back</button>
                ) : (
                    <>
                        {onPin ? (
                            <button type="button" data-action="pin-files" data-pin={pinned ? 'on' : 'off'} className={button} title={pinned ? 'Pinned: the panel reserves its gutter' : 'Pin the panel'} onClick={onPin}>
                                {pinned ? 'Pinned' : 'Pin'}
                            </button>
                        ) : null}
                        {onPopOut ? <button type="button" data-action="pop-out-files" className={button} title="Pop the panel into its own window" onClick={onPopOut}>Pop out</button> : null}
                        <button type="button" data-action="close-files" className={button} title="Close the panel (⌘B)" onClick={onClose}>Close</button>
                    </>
                )}
            </header>
            <div className="flex min-h-0 flex-1">
                {single ? null : (
                <aside className="w-[264px] shrink-0 overflow-auto border-r border-[var(--border-1)] py-1">
                    {filter === 'changed' ? (
                        // THE CHANGED FILTER (§4.3): the files grouped by who changed them — you included, `?` for a change
                        // nobody reported — in the tree's place. A group header names the count; its dot is the agent's.
                        state?.changed && state.changed.length > 0 ? (
                            <div data-changed-groups="" className="flex flex-col">
                                {state.changed.map((g) => (
                                    <div key={g.who}>
                                        <div data-changed-group={g.who} className="flex items-center gap-1.5 px-3 pb-0.5 pt-2 text-[11px] font-semibold uppercase tracking-[.04em] text-[var(--fg-4)]">
                                            <span className={`size-1.5 rounded-full ${g.who === 'you' ? 'bg-[var(--primary)]' : g.who === '?' ? 'border border-[var(--fg-4)]' : 'bg-[var(--accent)]'}`} />
                                            {g.who === '?' ? 'not attributed' : g.who} · {g.files.length} {g.files.length === 1 ? 'file' : 'files'}
                                        </div>
                                        {g.files.map((f) => {
                                            // The board's row: the time column (40px, mono), the path, `+n −m` only from a real diff, the marker.
                                            // The time and counts are the attribution's (the agent's own report); yours and the unreported have none.
                                            const d = state.files.find((x) => x.path === f);
                                            const at = d?.changedAt ?? null;
                                            const plus = d?.plus ?? null;
                                            const minus = d?.minus ?? null;
                                            return (
                                            <button key={f} type="button" data-changed-file={f} onClick={() => onSelect(f)} className={`flex w-full items-center gap-1.5 px-3 py-0.5 text-left font-mono text-[11.5px] hover:bg-[var(--bg-2)] ${open?.ok && open.path === f ? 'bg-[var(--bg-3)] text-[var(--fg-1)]' : 'text-[var(--fg-2)]'}`}>
                                                <span {...(at !== null ? { 'data-changed-at': at } : {})} className="w-10 shrink-0 text-[10px] text-[var(--fg-4)]">{at !== null ? hhmm(at) : ''}</span>
                                                <span className="truncate">{f}</span>
                                                {plus !== null ? <span data-plus={plus} className="shrink-0 text-[10px] text-[var(--success)]">+{plus}</span> : null}
                                                {minus !== null ? <span data-minus={minus} className="shrink-0 text-[10px] text-[var(--danger)]">−{minus}</span> : null}
                                                {marks.get(f) ? <Marker path={f} count={marks.get(f)!.count} tone={marks.get(f)!.tone} names={marks.get(f)!.names} /> : null}
                                            </button>
                                            );
                                        })}
                                    </div>
                                ))}
                            </div>
                        ) : (
                            <p className="px-3 py-2 text-xs text-[var(--fg-3)]">Nothing changed in this workspace this session.</p>
                        )
                    ) : tree === null && treeError !== null ? (
                        <p data-tree-error="" className="px-3 py-2 text-xs text-[var(--danger)]">The file tree could not be read: {treeError}</p>
                    ) : tree === null ? (
                        <div data-files-skeleton className="flex flex-col gap-2 px-3 py-2">
                            {Array.from({ length: 6 }, (_, i) => <div key={i} className="h-3 animate-pulse rounded bg-[var(--bg-2)]" style={{ width: `${55 + ((i * 17) % 40)}%` }} />)}
                        </div>
                    ) : (
                        fileActions ? (
                            <ContextMenu>
                                <ContextMenu.Trigger className="h-full">
                                    {/* Capture runs before the row's own handler: empty space targets the root (New file / New folder, Tynn #844), a row sets its own. */}
                                    <div data-file-menu="tree" className="h-full" onContextMenuCapture={() => setMenuFor({ path: '', target: 'tree-root' })}>
                                        <TreeNav nodes={decorate(tree, marks)} {...(open ? { selectedId: open.path } : {})} onSelect={(id, node) => { if (node.type !== 'folder') onSelect(id); }} expandedIds={[...(expanded ?? [])]} {...(onExpandedChange ? { onExpandedChange } : {})} onNodeContextMenu={(_e, node) => setMenuFor({ path: node.id, target: node.type === 'folder' ? 'tree-folder' : 'tree-file' })} virtualize height="100%" rowHeight={26} />
                                    </div>
                                </ContextMenu.Trigger>
                                {menuFor && menuFor.target !== 'tab' && (menuItems(menuFor.path, menuFor.target)?.length ?? 0) > 0 ? <ContextMenu.Content>{menuItems(menuFor.path, menuFor.target)}</ContextMenu.Content> : null}
                            </ContextMenu>
                        ) : (
                        <TreeNav nodes={decorate(tree, marks)} {...(open ? { selectedId: open.path } : {})} onSelect={(id, node) => { if (node.type !== 'folder') onSelect(id); }} expandedIds={[...(expanded ?? [])]} {...(onExpandedChange ? { onExpandedChange } : {})} virtualize height="100%" rowHeight={26} />
                        )
                    )}
                </aside>
                )}
                <div className="flex min-w-0 flex-1 flex-col">
                    <div data-file-tabs className="flex h-8 shrink-0 items-stretch border-b border-[var(--border-1)] bg-[var(--bg-1)]">
                        {shownTabs.map((t) => {
                            const active = open?.path === t;
                            const mark = marks.get(t);
                            const tab = (
                                <div key={t} data-file-tab={t} {...(fileActions ? { 'data-file-menu': 'tab' } : {})} {...(edit?.dirty && open?.path === t ? { 'data-dirty': 'true' } : {})} {...(paused.some((p) => p.path === t) ? { 'data-paused': 'true' } : {})} className={`flex items-center gap-1 border-r border-[var(--border-1)] px-3 text-xs ${active ? 'bg-[var(--bg-0)] text-[var(--fg-1)]' : 'text-[var(--fg-3)]'} ${mark?.tone === 'writing' ? 'shadow-[inset_0_-2px_0_var(--accent)]' : ''}`}>
                                    <button type="button" onClick={() => onSelect(t)} className="font-mono">{t.split('/').pop()}</button>
                                    {edit?.dirty && open?.path === t ? <span data-dirty-dot="" title="Unsaved changes (Ctrl+S saves)" className="text-[var(--accent)]">●</span> : null}
                                    {onOpenInPane && !single ? <button type="button" data-action="open-in-pane" aria-label={`open ${t} in a pane`} title="Open in its own pane beside the terminals" onClick={() => onOpenInPane(t)} className="text-[var(--fg-4)] hover:text-[var(--fg-1)]">⧉</button> : null}
                                    <button type="button" aria-label={`close ${t}`} onClick={() => onCloseTab(t)} className="text-[var(--fg-4)] hover:text-[var(--fg-1)]">×</button>
                                </div>
                            );
                            return fileActions ? (
                                <ContextMenu key={t}>
                                    <ContextMenu.Trigger className="flex">{tab}</ContextMenu.Trigger>
                                    <ContextMenu.Content>{menuItems(t, 'tab')}</ContextMenu.Content>
                                </ContextMenu>
                            ) : tab;
                        })}
                        {edit && open?.ok && edit.dirty && !edit.conflict ? (
                            <button type="button" data-action="save-file" onClick={edit.onSave} className="ml-auto mr-2 my-1 rounded-md border border-[var(--border-1)] px-2 py-0.5 text-xs hover:bg-[var(--bg-2)]">Save</button>
                        ) : null}
                    </div>
                    {edit?.saveError && !edit.conflict ? (
                        <p data-save-error="" className="m-3 rounded-lg border border-[var(--danger)] p-2 text-xs">Not saved: {edit.saveError}</p>
                    ) : null}
                    {edit?.conflict ? (
                        <div data-conflict={edit.conflict.path} data-tone="bad" className="m-3 rounded-lg border border-[var(--danger)] p-3 text-sm">
                          <div className="flex items-start gap-2">
                            <span data-conflict-icon="git-merge" className="mt-0.5 text-[var(--danger)]"><Icon name="git-merge" size="sm" /></span>
                            <div className="min-w-0 flex-1">
                            {/* THE BOARD'S WORDS: which lines they changed and which you did, from a real diff against the text as opened; the author only when an agent is writing this file. */}
                            {edit.conflict.baseline !== undefined && open?.ok ? (
                                <p data-conflict-words="" className="font-medium">{conflictWords(edit.conflict.baseline, open.text, edit.conflict.onDisk, state?.activity.find((a) => a.verb === 'writing' && a.path === edit.conflict!.path)?.agent ?? null)}</p>
                            ) : (
                                <p className="font-medium">{edit.conflict.path} changed on disk while you were editing it.</p>
                            )}
                            <p className="mt-1 text-[var(--fg-3)]">{conflictBody(edit.told ?? null)}</p>
                            <div className="mt-2 flex gap-2">
                                <button type="button" data-action="compare" aria-pressed={edit.comparing === true} onClick={() => edit.onCompare?.()} className="rounded-md border border-[var(--primary)] bg-[var(--primary)] px-2 py-0.5 text-xs text-white hover:opacity-90">Compare</button>
                                <button type="button" data-action="keep-mine" onClick={edit.onKeepMine} className="rounded-md border border-[var(--border-1)] px-2 py-0.5 text-xs hover:bg-[var(--bg-2)]">Keep mine</button>
                                <button type="button" data-action="take-theirs" onClick={edit.onTakeTheirs} className="rounded-md border border-[var(--border-1)] px-2 py-0.5 text-xs hover:bg-[var(--bg-2)]">{takeLabel(state?.activity.find((a) => a.verb === 'writing' && a.path === edit.conflict!.path)?.agent ?? null)}</button>
                            </div>
                            </div>
                          </div>
                            {/* Compare: your buffer (before) against the disk (after), in the kit's diff — read-only, nothing is written. */}
                            {edit.comparing && open?.ok ? (
                                <div data-conflict-compare={edit.conflict.path} className="mt-2 max-h-80 overflow-auto rounded border border-[var(--border-1)]">
                                    <FancyDiff source={{ before: open.text, after: edit.conflict.onDisk }} variant="compare" mode="inline" />
                                </div>
                            ) : null}
                        </div>
                    ) : null}
                    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
                        {/* THE BLIND STATE (the board): a file that changed on disk with NO agent report says so over its body. Genie does not guess the author. */}
                        {open?.ok && state?.unreported.includes(open.path) ? (
                            <div data-unreported-banner={open.path} className="flex shrink-0 items-center gap-2 border-b border-[var(--border-1)] bg-[var(--bg-1)] px-4 py-1.5 text-xs text-[var(--fg-3)]">
                                <Icon name="eye-off" size="xs" />
                                No agent reported this change
                                {onShowDiff ? <button type="button" data-action="show-diff" onClick={onShowDiff} className="ml-auto rounded-md border border-[var(--border-1)] px-2 py-0.5 text-xs hover:bg-[var(--bg-2)]">Show diff</button> : null}
                            </div>
                        ) : null}
                        {/* Show diff: git's last commit against the open text — captioned as that, never as anyone's change. */}
                        {open?.ok && blindDiff && blindDiff.path === open.path ? (
                            blindDiff.before === null ? (
                                <p data-blind-diff-none={open.path} className="shrink-0 border-b border-[var(--border-1)] px-4 py-1.5 text-xs text-[var(--fg-3)]">Not in the last commit, so there is nothing to compare it with.</p>
                            ) : (
                                <div data-blind-diff={open.path} className="max-h-80 shrink-0 overflow-auto border-b border-[var(--border-1)]">
                                    <p className="px-4 py-1 text-[11px] text-[var(--fg-4)]">Against the last commit</p>
                                    <FancyDiff source={{ before: blindDiff.before, after: open.text }} variant="compare" mode="inline" />
                                </div>
                            )
                        ) : null}
                        {/* The open file NEVER waits for the tree: the tree is the workspace's whole walk (single mode never
                            even draws it), and gating the body on it left a file that HAD been read as a blank pane. */}
                        {open === null ? (
                            single ? (
                                <p data-file-opening={single} className="p-4 text-sm text-[var(--fg-3)]">Opening {single}…</p>
                            ) : tree === null ? null : (
                                <p className="p-4 text-sm text-[var(--fg-3)]">No file open. Pick one in the tree.</p>
                            )
                        ) : open.ok ? (
                            <div className="flex min-h-0 flex-1 flex-col">
                                {/* THE CRUMB (the board): the path, segment by segment, over the editor. */}
                                <div data-file-crumb={open.path} className="flex shrink-0 items-center border-b border-[var(--border-1)] px-4 py-1 font-mono text-[11px] text-[var(--fg-4)]">
                                    {fileCrumb(open.path).map((seg, i) => (
                                        <span key={`${i}-${seg}`}>{i > 0 ? <span className="mx-1">/</span> : null}{seg}</span>
                                    ))}
                                </div>
                                {/* THE EDITOR IS THE PANE (Tynn #840; Genie 1's genie#603): fancy-code's CodeEditor fills the column and
                                    its Panel is the one scroller. FileViewer was a content-high block — the editor shrank to its text and
                                    the space under it was dead, which read as "cannot edit". Media still opens in the viewer. */}
                                <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
                                    {(() => {
                                        const kind = resolveFileKind({ filename: open.path });
                                        return kind.kind === 'media' ? (
                                            <FileViewer filename={open.path} value={open.text} theme="auto" className="min-h-0 flex-1" />
                                        ) : (
                                            <CodeEditor className="flex h-full min-h-0 flex-col" value={open.text} language={kind.language} readOnly={!edit} {...(edit ? { onChange: edit.onChange } : {})} {...(line ? { cursorLine: line, highlightLines: [line] } : {})} theme="auto">
                                                <CodeEditor.Panel className="min-h-0 flex-1" />
                                            </CodeEditor>
                                        );
                                    })()}
                                </div>
                                {/* THE STATUS BAR (the board): language · line ending · encoding · who is in the file. No cursor position — the viewer reports none. */}
                                <StatusBar path={open.path} text={open.text} activity={state?.activity ?? []} hunks={edit?.conflict && edit.conflict.path === open.path ? conflictHunks(open.text, edit.conflict.onDisk) : null} />
                            </div>
                        ) : (
                            <div data-tab-error className="m-4 rounded-lg border border-[var(--danger)] p-3 text-sm">
                                <p className="font-mono text-xs text-[var(--fg-4)]">{open.path}</p>
                                <p className="mt-1">{open.error}</p>
                            </div>
                        )}
                    </div>
                </div>
            </div>
            {state && (state.activity.length > 0 || touched.size > 0 || paused.length > 0) ? (
                <footer className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-t border-[var(--border-1)] px-3 py-1.5 text-xs text-[var(--fg-2)]">
                    {state.activity.map((a) => (
                        <span key={`${a.agent}:${a.path}`} className="inline-flex items-center gap-1">
                            <span className={a.verb === 'writing' ? 'text-[var(--accent)]' : 'text-[var(--fg-4)]'}>●</span>
                            <span>{`${a.agent} ${a.verb} ${a.path}`}</span>
                        </span>
                    ))}
                    {/* ASKED, not stopped: Genie cannot halt a provider's tool call; it told the agent and says so (§4.3). */}
                    {paused.map((p) => (
                        <span key={`pause:${p.agent}:${p.path}`} data-paused={p.path} className="inline-flex items-center gap-1 text-[var(--warning)]">
                            <span>⏸</span>
                            <span>{`${p.agent} asked to pause on ${p.path} — you have unsaved edits there`}</span>
                        </span>
                    ))}
                    {/* The count, and the door to the Changed filter (the board's header chip is the other door). */}
                    {touched.size > 0 ? (
                        <button type="button" data-action="show-changed" onClick={() => onFilter?.('changed')} className="ml-auto hover:text-[var(--fg-1)]">{touched.size} changed in this workspace ▸</button>
                    ) : null}
                </footer>
            ) : null}
        </section>
    );
}
