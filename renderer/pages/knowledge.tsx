import React, {
    Suspense,
    lazy,
    useCallback,
    useEffect,
    useMemo,
    useState,
    type CSSProperties,
} from 'react';
import { ContentRenderer, Heading, Pillbox, Select, Text } from '@particle-academy/react-fancy';
import {
    IconGraph,
    IconListTree,
    IconPlus,
    IconSearch,
    IconTrash,
    IconX,
} from '../components/Master/icons';
import {
    api,
    hasGenieBridge,
    MEMORY_CLASSES,
    type KnowledgeGraphData,
    type KnowledgeNode,
    type KnowledgeScope,
    type KnowledgeScopeKind,
    type KnowledgeSearchResult,
    type LinkAuditEntry,
    type MemoryClass,
    type WorkspaceRow,
} from '../lib/genie';
import { circleLayout } from '../lib/knowledge-graph';
// Pure, and tested without a window: the two places this page could silently
// misreport where a memory lives.
import {
    knowledgeScopeLabel,
    parseKnowledgeScopeValue,
    scopePickerValue,
} from '../lib/knowledge-scope';

/**
 * The Workstation Knowledge Graph window (Wish #87). A separate Genie-skinned
 * BrowserWindow (opened by knowledge.openWindow) loads this page. It's the
 * HUMAN surface over Genie's local, cross-workspace memory store — the on-demand
 * queryable replacement for bloated system-wide agent prompt instructions.
 *
 *   - Left: search + a list of memories, OR a graph view of nodes+edges.
 *   - Right: the selected memory rendered as markdown + its links (clickable to
 *     walk the graph), or the react-fancy Editor for add/edit.
 *
 * Nodes are markdown memories; `[[wikilink]]` refs between them are the edges.
 * All data loading is gated behind useEffect / hasGenieBridge, so the page is
 * SSR-safe (Next statically renders it at build time). The Editor is lazy-loaded
 * for the same reason the plugin editor host lazy-loads it — its compound
 * statics don't survive a lazy wrapper otherwise, and it keeps the WYSIWYG out
 * of the first paint.
 */

// The Document editor — react-fancy's compound Editor (markdown in/out), the
// SAME surface Genie's Markdown editor plugin uses (components/Plugins/…).
const DocumentEditorLazy = lazy(() => import('../components/Plugins/DocumentEditor'));

const ACCENT = '#a78bfa';
const ACCENT_DIM = '#8b5cf6';
const BORDER = '1px solid rgba(255,255,255,0.08)';

type Mode = 'view' | 'edit' | 'create';
type LeftView = 'list' | 'graph';

/** `all` is the window's default for both filters, and it is not a courtesy: this
 *  is the human's view of the WHOLE workstation store, so narrowing it is
 *  something the user asks for rather than something the window assumes. */
type ClassFilter = MemoryClass | 'all';
type ScopeFilter = KnowledgeScopeKind | 'all';

// Both label maps are exhaustive `Record`s, so a class or a scope rung added to
// the store and not to this window is a COMPILE error rather than a filter that
// silently cannot reach half the store.
const CLASS_LABELS: Record<MemoryClass, string> = {
    knowledge: 'Knowledge — where this is in the documents',
    profile: 'Profile — what is true of you',
    episodic: 'Episodic — what happened, and when',
    procedural: 'Procedural — what was learned from doing this',
};

const CLASS_OPTIONS = [
    { value: 'all', label: 'Every kind' },
    ...MEMORY_CLASSES.map((c) => ({ value: c as string, label: CLASS_LABELS[c] })),
];

const SCOPE_LABELS: Record<KnowledgeScopeKind, string> = {
    system: 'Workstation',
    workspace: 'Workspaces',
    gapp: 'Genie Apps',
};

const SCOPE_FILTER_OPTIONS = [
    { value: 'all', label: 'Every scope' },
    ...(Object.keys(SCOPE_LABELS) as KnowledgeScopeKind[]).map((k) => ({
        value: k as string,
        label: SCOPE_LABELS[k],
    })),
];


function truncate(s: string, n: number): string {
    return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

export default function KnowledgePage() {
    const [nodes, setNodes] = useState<KnowledgeNode[]>([]);
    const [graph, setGraph] = useState<KnowledgeGraphData | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    const [query, setQuery] = useState('');
    const [results, setResults] = useState<KnowledgeSearchResult[] | null>(null);
    const [classFilter, setClassFilter] = useState<ClassFilter>('all');
    const [scopeFilter, setScopeFilter] = useState<ScopeFilter>('all');
    /** Only for LABELS and the editor's scope picker — a workspace id in the UI
     *  is a lookup the reader has to do by hand. */
    const [workspaces, setWorkspaces] = useState<WorkspaceRow[]>([]);
    const [linkAudit, setLinkAudit] = useState<LinkAuditEntry[]>([]);

    const [selectedId, setSelectedId] = useState<string | null>(null);
    const [leftView, setLeftView] = useState<LeftView>('list');
    const [mode, setMode] = useState<Mode>('view');
    const [busy, setBusy] = useState(false);

    const nodesById = useMemo(() => {
        const m = new Map<string, KnowledgeNode>();
        for (const n of nodes) m.set(n.id, n);
        return m;
    }, [nodes]);
    const selected = selectedId ? nodesById.get(selectedId) ?? null : null;

    // Fetch the full list + graph together (the list carries every node body, so
    // selecting never needs a second round-trip for a memory already in view).
    const reload = useCallback(async () => {
        const [ns, g] = await Promise.all([
            api().knowledge.list({
                class: classFilter === 'all' ? undefined : classFilter,
                // Narrowed in SQL main-side. Filtering the returned page here
                // instead would show a short list and call it the whole store.
                scope: scopeFilter === 'all' ? undefined : { kind: scopeFilter },
            }),
            api().knowledge.graph(),
        ]);
        setNodes(ns);
        setGraph(g);
        return ns;
    }, [classFilter, scopeFilter]);

    // The workspace list is fetched once, for labels and the editor's scope
    // picker. It is not knowledge data and never gates the page: a failure here
    // costs a friendly name, not a memory.
    useEffect(() => {
        if (!hasGenieBridge()) return;
        void api()
            .workspaces.list()
            .then(setWorkspaces)
            .catch(() => setWorkspaces([]));
    }, []);

    // The one-time audit of links the tightened resolver stopped resolving. Empty
    // on most machines, which is the audit doing its job rather than a wasted one.
    useEffect(() => {
        if (!hasGenieBridge()) return;
        void api()
            .knowledge.linkAudit()
            .then(setLinkAudit)
            .catch(() => setLinkAudit([]));
    }, []);

    useEffect(() => {
        if (!hasGenieBridge()) {
            setLoading(false);
            return;
        }
        let cancelled = false;
        (async () => {
            try {
                const ns = await reload();
                if (cancelled) return;
                setSelectedId((cur) => cur ?? ns[0]?.id ?? null);
            } catch (e) {
                if (!cancelled) setError(String(e));
            } finally {
                if (!cancelled) setLoading(false);
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [reload]);

    // Live-refresh when an agent (via MCP) or another window mutates the store —
    // any add / update / delete / link re-fetches the list + graph.
    useEffect(() => {
        if (!hasGenieBridge()) return;
        return api().on.knowledgeChanged(() => {
            void reload().catch(() => {});
        });
    }, [reload]);

    // Debounced search: an empty query shows the full list (results === null).
    useEffect(() => {
        if (!hasGenieBridge()) return;
        const q = query.trim();
        if (!q) {
            setResults(null);
            return;
        }
        const t = setTimeout(() => {
            void api()
                .knowledge.search(q, {
                    class: classFilter === 'all' ? undefined : classFilter,
                    scope: scopeFilter === 'all' ? undefined : { kind: scopeFilter },
                })
                .then(setResults)
                .catch(() => setResults([]));
        }, 200);
        return () => clearTimeout(t);
    }, [query, classFilter, scopeFilter]);

    const selectNode = useCallback(
        async (id: string) => {
            setSelectedId(id);
            setMode('view');
            // A search hit (or a graph node) may not be in the loaded list if it
            // was capped — pull the full node on demand.
            if (!nodesById.has(id)) {
                const n = await api().knowledge.get(id).catch(() => null);
                if (n) {
                    setNodes((prev) =>
                        prev.some((x) => x.id === n.id) ? prev : [...prev, n],
                    );
                }
            }
        },
        [nodesById],
    );

    const saveMemory = useCallback(
        async (draft: {
            id?: string;
            title: string;
            tags: string[];
            body: string;
            class: MemoryClass;
            scope: KnowledgeScope;
        }) => {
            setBusy(true);
            try {
                // Edges are derived main-side from the body's `[[wikilinks]]`
                // (resolved by title/slug at read time), so we send only the
                // content — no explicit `links`. Omitting it also leaves any
                // extra edges an agent attached untouched on update.
                const input = {
                    title: draft.title,
                    body: draft.body,
                    tags: draft.tags,
                    class: draft.class,
                    scope: draft.scope,
                };
                const saved = draft.id
                    ? await api().knowledge.update(draft.id, input)
                    : await api().knowledge.add(input);
                await reload();
                if (saved) setSelectedId(saved.id);
                setMode('view');
                setError(null);
            } catch (e) {
                setError(String(e));
            } finally {
                setBusy(false);
            }
        },
        [reload],
    );

    const deleteMemory = useCallback(
        async (id: string) => {
            setBusy(true);
            try {
                await api().knowledge.delete(id);
                const ns = await reload();
                setSelectedId((cur) => (cur === id ? ns[0]?.id ?? null : cur));
                setMode('view');
                setError(null);
            } catch (e) {
                setError(String(e));
            } finally {
                setBusy(false);
            }
        },
        [reload],
    );

    if (!hasGenieBridge()) {
        return (
            <div className="surface" style={{ padding: 24 }}>
                <Text size="sm" className="text-zinc-500">
                    The Knowledge Graph runs inside the Genie desktop app.
                </Text>
            </div>
        );
    }

    const listRows: KnowledgeSearchResult[] =
        results ??
        nodes.map((n) => ({
            id: n.id,
            title: n.title,
            snippet: '',
            score: 0,
            tags: n.tags,
            class: n.class,
            scope: n.scope,
            ns: n.ns,
        }));

    return (
        <div
            className="surface"
            style={{ display: 'flex', flexDirection: 'column', height: '100vh', overflow: 'hidden' }}
        >
            {/* Header */}
            <header
                style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    padding: '12px 16px',
                    borderBottom: BORDER,
                    flex: '0 0 auto',
                }}
            >
                <IconGraph size={18} />
                <Heading as="h1" size="sm">
                    Knowledge Graph
                </Heading>
                <Text size="xs" className="text-zinc-500">
                    {nodes.length} {nodes.length === 1 ? 'memory' : 'memories'}
                </Text>
                <span style={{ flex: 1 }} />
                <button
                    type="button"
                    onClick={() => {
                        setMode('create');
                    }}
                    style={primaryBtnStyle}
                    title="Add a new memory"
                >
                    <IconPlus size={13} /> New memory
                </button>
            </header>

            {error && (
                <div
                    style={{
                        padding: '8px 16px',
                        color: '#fda4af',
                        fontSize: 12,
                        borderBottom: BORDER,
                    }}
                >
                    {error}
                </div>
            )}

            <LinkAuditNotice
                entries={linkAudit}
                onOpen={(id) => void selectNode(id)}
                onDismiss={() => {
                    // Optimistic: the rows are marked reviewed, not deleted, so
                    // the worst case of a failed write is the notice returning on
                    // the next open — not a finding lost.
                    setLinkAudit([]);
                    void api().knowledge.dismissLinkAudit().catch(() => {});
                }}
            />

            <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
                {/* Left: search + list / graph. */}
                <div
                    style={{
                        width: 340,
                        flex: '0 0 340px',
                        borderRight: BORDER,
                        display: 'flex',
                        flexDirection: 'column',
                        minHeight: 0,
                    }}
                >
                    <div style={{ padding: 10, display: 'flex', gap: 6, flex: '0 0 auto' }}>
                        <Segmented
                            value={leftView}
                            onChange={setLeftView}
                            options={[
                                { id: 'list', label: 'List', icon: <IconListTree size={13} /> },
                                { id: 'graph', label: 'Graph', icon: <IconGraph size={13} /> },
                            ]}
                        />
                    </div>
                    <div style={{ padding: '0 10px 10px', flex: '0 0 auto' }}>
                        <div style={searchWrapStyle}>
                            <IconSearch size={13} />
                            <input
                                value={query}
                                onChange={(e) => setQuery(e.target.value)}
                                placeholder="Search memories…"
                                style={searchInputStyle}
                                aria-label="Search memories"
                            />
                            {query && (
                                <button
                                    type="button"
                                    onClick={() => setQuery('')}
                                    style={clearBtnStyle}
                                    title="Clear search"
                                    aria-label="Clear search"
                                >
                                    <IconX size={12} />
                                </button>
                            )}
                        </div>
                        {/* Both filters narrow the SQL, not the returned page — a
                            filtered view that quietly showed a truncated slice of
                            an unfiltered fetch would be worse than no filter. */}
                        <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
                            <div style={{ flex: 1, minWidth: 0 }}>
                                <Select
                                    value={classFilter}
                                    onValueChange={(v) => setClassFilter(v as ClassFilter)}
                                    list={CLASS_OPTIONS}
                                />
                            </div>
                            <div style={{ flex: 1, minWidth: 0 }}>
                                <Select
                                    value={scopeFilter}
                                    onValueChange={(v) => setScopeFilter(v as ScopeFilter)}
                                    list={SCOPE_FILTER_OPTIONS}
                                />
                            </div>
                        </div>
                    </div>

                    {leftView === 'list' ? (
                        <div style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
                            {loading && (
                                <div style={mutedRowStyle}>Loading…</div>
                            )}
                            {!loading && listRows.length === 0 && (
                                <div style={mutedRowStyle}>
                                    {results !== null
                                        ? 'No memories match your search.'
                                        : 'No memories yet. Add one to get started.'}
                                </div>
                            )}
                            <ul style={{ listStyle: 'none', margin: 0, padding: '0 8px 8px' }}>
                                {listRows.map((r) => {
                                    const on = r.id === selectedId && mode === 'view';
                                    return (
                                        <li key={r.id}>
                                            <button
                                                type="button"
                                                onClick={() => void selectNode(r.id)}
                                                style={{
                                                    ...listItemStyle,
                                                    background: on
                                                        ? 'rgba(167,139,250,0.14)'
                                                        : 'transparent',
                                                }}
                                            >
                                                <span style={listTitleStyle}>{r.title}</span>
                                                <span
                                                    style={{
                                                        display: 'flex',
                                                        flexWrap: 'wrap',
                                                        gap: 4,
                                                        marginTop: 3,
                                                    }}
                                                >
                                                    <ScopeChip
                                                        scope={r.scope}
                                                        workspaces={workspaces}
                                                    />
                                                    <ClassChip value={r.class} />
                                                    {r.ns && <NsChip ns={r.ns} />}
                                                </span>
                                                {r.snippet && (
                                                    <span style={snippetStyle}>{r.snippet}</span>
                                                )}
                                                {r.tags.length > 0 && (
                                                    <span style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 4 }}>
                                                        {r.tags.slice(0, 4).map((t) => (
                                                            <TagChip key={t} label={t} />
                                                        ))}
                                                    </span>
                                                )}
                                            </button>
                                        </li>
                                    );
                                })}
                            </ul>
                        </div>
                    ) : (
                        <GraphView
                            graph={graph}
                            selectedId={selectedId}
                            onSelect={(id) => void selectNode(id)}
                        />
                    )}
                </div>

                {/* Right: view or edit. */}
                <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
                    {mode === 'view' ? (
                        selected ? (
                            <MemoryView
                                node={selected}
                                nodesById={nodesById}
                                workspaces={workspaces}
                                backlinks={nodes.filter((n) => n.links?.includes(selected.id))}
                                onOpen={(id) => void selectNode(id)}
                                onEdit={() => setMode('edit')}
                                onDelete={() => void deleteMemory(selected.id)}
                                busy={busy}
                            />
                        ) : (
                            <div style={emptyPaneStyle}>
                                <IconGraph size={30} />
                                <Text size="sm" className="text-zinc-500" style={{ marginTop: 10 }}>
                                    Select a memory, or add a new one.
                                </Text>
                            </div>
                        )
                    ) : (
                        <MemoryEditor
                            key={mode === 'create' ? 'new' : selectedId}
                            initial={
                                mode === 'edit' && selected
                                    ? {
                                          id: selected.id,
                                          title: selected.title,
                                          tags: selected.tags,
                                          body: selected.body,
                                          class: selected.class,
                                          scope: selected.scope,
                                      }
                                    : {
                                          title: '',
                                          tags: [],
                                          body: '',
                                          class: 'knowledge' as MemoryClass,
                                          // A memory written HERE is the human's,
                                          // and this window is workstation-wide —
                                          // so `system` is the honest default. An
                                          // agent's writes default to its own
                                          // workspace instead, because an agent
                                          // has one.
                                          scope: { kind: 'system' } as KnowledgeScope,
                                      }
                            }
                            workspaces={workspaces}
                            busy={busy}
                            onCancel={() => setMode('view')}
                            onSave={(draft) => void saveMemory(draft)}
                        />
                    )}
                </div>
            </div>
        </div>
    );
}

/** A small two-option segmented toggle (List / Graph). */
function Segmented<T extends string>({
    value,
    onChange,
    options,
}: {
    value: T;
    onChange: (v: T) => void;
    options: Array<{ id: T; label: string; icon?: React.ReactNode }>;
}) {
    return (
        <div style={{ display: 'inline-flex', border: BORDER, borderRadius: 8, overflow: 'hidden' }}>
            {options.map((o) => {
                const on = o.id === value;
                return (
                    <button
                        key={o.id}
                        type="button"
                        onClick={() => onChange(o.id)}
                        style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: 5,
                            padding: '5px 12px',
                            fontSize: 12,
                            border: 'none',
                            cursor: 'pointer',
                            background: on ? 'rgba(167,139,250,0.18)' : 'transparent',
                            color: on ? '#ede9fe' : '#a1a1aa',
                        }}
                    >
                        {o.icon}
                        {o.label}
                    </button>
                );
            })}
        </div>
    );
}

/** A tag pill. */
function TagChip({ label }: { label: string }) {
    return (
        <span
            style={{
                display: 'inline-block',
                padding: '1px 7px',
                borderRadius: 999,
                fontSize: 11,
                background: 'rgba(255,255,255,0.06)',
                color: '#a1a1aa',
                border: BORDER,
            }}
        >
            {label}
        </span>
    );
}

/** The relationship view: a dependency-free circular layout of nodes + edges. */
function GraphView({
    graph,
    selectedId,
    onSelect,
}: {
    graph: KnowledgeGraphData | null;
    selectedId: string | null;
    onSelect: (id: string) => void;
}) {
    const W = 640;
    const H = 560;
    const ids = useMemo(() => (graph?.nodes ?? []).map((n) => n.id), [graph]);
    const layout = useMemo(() => circleLayout(ids, W, H, 64), [ids]);

    if (!graph || graph.nodes.length === 0) {
        return (
            <div style={{ ...emptyPaneStyle, flex: 1 }}>
                <IconGraph size={26} />
                <Text size="xs" className="text-zinc-500" style={{ marginTop: 8 }}>
                    No memories to graph yet.
                </Text>
            </div>
        );
    }

    const neighbors = new Set<string>();
    for (const e of graph.edges) {
        if (e.source === selectedId) neighbors.add(e.target);
        else if (e.target === selectedId) neighbors.add(e.source);
    }

    return (
        <div style={{ flex: 1, minHeight: 0, overflow: 'hidden', padding: 8 }}>
            <svg viewBox={`0 0 ${W} ${H}`} width="100%" height="100%" style={{ display: 'block' }}>
                {graph.edges.map((e, i) => {
                    const a = layout.get(e.source);
                    const b = layout.get(e.target);
                    if (!a || !b) return null;
                    const active = e.source === selectedId || e.target === selectedId;
                    return (
                        <line
                            key={i}
                            x1={a.x}
                            y1={a.y}
                            x2={b.x}
                            y2={b.y}
                            stroke={active ? ACCENT : 'rgba(255,255,255,0.14)'}
                            strokeWidth={active ? 1.6 : 1}
                        />
                    );
                })}
                {graph.nodes.map((n) => {
                    const p = layout.get(n.id);
                    if (!p) return null;
                    const isSel = n.id === selectedId;
                    const isNb = neighbors.has(n.id);
                    const r = isSel ? 9 : 6.5;
                    return (
                        <g
                            key={n.id}
                            transform={`translate(${p.x} ${p.y})`}
                            style={{ cursor: 'pointer' }}
                            onClick={() => onSelect(n.id)}
                        >
                            <circle
                                r={r}
                                fill={isSel ? ACCENT : isNb ? ACCENT_DIM : '#3f3f46'}
                                stroke={isSel ? '#ede9fe' : 'rgba(255,255,255,0.25)'}
                                strokeWidth={isSel ? 2 : 1}
                            />
                            <text
                                x={0}
                                y={r + 12}
                                textAnchor="middle"
                                fontSize={11}
                                fill={isSel ? '#ede9fe' : '#a1a1aa'}
                                style={{ pointerEvents: 'none', userSelect: 'none' }}
                            >
                                {truncate(n.title, 18)}
                            </text>
                        </g>
                    );
                })}
            </svg>
        </div>
    );
}

/** The selected memory: rendered markdown + its outgoing/incoming links. */
function MemoryView({
    node,
    nodesById,
    workspaces,
    backlinks,
    onOpen,
    onEdit,
    onDelete,
    busy,
}: {
    node: KnowledgeNode;
    nodesById: Map<string, KnowledgeNode>;
    workspaces: WorkspaceRow[];
    backlinks: KnowledgeNode[];
    onOpen: (id: string) => void;
    onEdit: () => void;
    onDelete: () => void;
    busy: boolean;
}) {
    const linked = (node.links ?? [])
        .map((id) => nodesById.get(id))
        .filter((n): n is KnowledgeNode => !!n);
    const updated = new Date(node.updatedAt); // epoch ms
    const updatedLabel = Number.isNaN(updated.getTime())
        ? '—'
        : updated.toLocaleString();

    return (
        <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
            <div
                style={{
                    display: 'flex',
                    alignItems: 'flex-start',
                    gap: 10,
                    padding: '18px 24px 10px',
                    borderBottom: BORDER,
                    flex: '0 0 auto',
                }}
            >
                <div style={{ flex: 1, minWidth: 0 }}>
                    <Heading as="h2" size="md">
                        {node.title || 'Untitled memory'}
                    </Heading>
                    <div
                        style={{
                            display: 'flex',
                            alignItems: 'center',
                            flexWrap: 'wrap',
                            gap: 8,
                            marginTop: 6,
                        }}
                    >
                        <span style={sourceBadgeStyle(node.source)}>
                            {node.source === 'agent' ? 'agent' : 'you'}
                        </span>
                        <ScopeChip scope={node.scope} workspaces={workspaces} />
                        <ClassChip value={node.class} />
                        {node.ns && <NsChip ns={node.ns} />}
                        <Text size="xs" className="text-zinc-500">
                            updated {updatedLabel}
                        </Text>
                    </div>
                    {node.tags.length > 0 && (
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 8 }}>
                            {node.tags.map((t) => (
                                <TagChip key={t} label={t} />
                            ))}
                        </div>
                    )}
                </div>
                <div style={{ display: 'flex', gap: 6, flex: '0 0 auto' }}>
                    <button type="button" style={secondaryBtnStyle} onClick={onEdit} disabled={busy}>
                        Edit
                    </button>
                    <button
                        type="button"
                        style={dangerBtnStyle}
                        onClick={onDelete}
                        disabled={busy}
                        title="Delete this memory"
                        aria-label="Delete memory"
                    >
                        <IconTrash size={13} />
                    </button>
                </div>
            </div>

            <div style={{ flex: 1, overflowY: 'auto', padding: '20px 24px', minHeight: 0 }}>
                <UnresolvedNotice unresolved={node.unresolved ?? []} />

                <article className="prose prose-invert max-w-3xl">
                    <ContentRenderer value={node.body || '_No content._'} format="markdown" />
                </article>

                {(linked.length > 0 || backlinks.length > 0) && (
                    <div style={{ marginTop: 24, borderTop: BORDER, paddingTop: 16 }}>
                        {linked.length > 0 && (
                            <LinkGroup
                                label="Links to"
                                nodes={linked}
                                onOpen={onOpen}
                            />
                        )}
                        {backlinks.length > 0 && (
                            <LinkGroup
                                label="Linked from"
                                nodes={backlinks}
                                onOpen={onOpen}
                            />
                        )}
                    </div>
                )}
            </div>
        </div>
    );
}

/**
 * The ONE-TIME notice for links that link resolution stopped resolving.
 *
 * Link resolution used to point an ambiguous `[[wikilink]]` at whichever memory
 * happened to be stored last. It now points at nothing — safer, but a link that
 * worked by luck stopping silently is the kind of change nobody notices, and a
 * graph that quietly gets sparser is exactly what the change was meant to prevent.
 * So each one is named here, once, with what it used to point at.
 *
 * Dismissing marks them reviewed; it does not delete them.
 */
function LinkAuditNotice({
    entries,
    onOpen,
    onDismiss,
}: {
    entries: LinkAuditEntry[];
    onOpen: (id: string) => void;
    onDismiss: () => void;
}) {
    if (entries.length === 0) return null;
    return (
        <div
            style={{
                padding: '10px 16px',
                borderBottom: BORDER,
                background: 'rgba(251,191,36,0.07)',
            }}
        >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <Text size="xs" style={{ color: '#fcd34d' }}>
                    {entries.length === 1
                        ? '1 link became ambiguous when link resolution was tightened.'
                        : `${entries.length} links became ambiguous when link resolution was tightened.`}{' '}
                    They used to point at one memory by luck; now they point at none. Link by id to
                    say which you meant.
                </Text>
                <span style={{ flex: 1 }} />
                <button type="button" style={secondaryBtnStyle} onClick={onDismiss}>
                    Dismiss
                </button>
            </div>
            <ul style={{ margin: '6px 0 0', padding: '0 0 0 16px' }}>
                {entries.slice(0, 8).map((e) => (
                    <li key={`${e.fromId}:${e.toRef}`} style={{ fontSize: 12, color: '#d4d4d8' }}>
                        <button
                            type="button"
                            onClick={() => onOpen(e.fromId)}
                            style={{ ...linkChipStyle, padding: '0 4px' }}
                            title="Open this memory"
                        >
                            {e.fromTitle ?? e.fromId}
                        </button>{' '}
                        <code>[[{e.toRef}]]</code> — was “{e.wasTitle ?? e.wasId}”, one of{' '}
                        {e.candidates}.
                    </li>
                ))}
                {entries.length > 8 && (
                    <li style={{ fontSize: 12, color: '#a1a1aa' }}>
                        …and {entries.length - 8} more.
                    </li>
                )}
            </ul>
        </div>
    );
}

/** Whose reasoning this memory belongs in. NOT a padlock — every scope is
 *  readable from here and from any agent; the chip is orientation, not access. */
function ScopeChip({ scope, workspaces }: { scope: KnowledgeScope; workspaces: WorkspaceRow[] }) {
    return (
        <span style={metaChipStyle('rgba(56,189,248,0.35)', '#7dd3fc')}>
            {knowledgeScopeLabel(scope, workspaces)}
        </span>
    );
}

/** Which memory this is — the four kinds answer four different questions. */
function ClassChip({ value }: { value: MemoryClass }) {
    return <span style={metaChipStyle('rgba(163,163,163,0.3)', '#a1a1aa')}>{value}</span>;
}

/** The managed namespace a memory came from — Genie's own guides, or a pack.
 *  Two packs may legitimately both ship a "Volume 1", so a title alone does not
 *  say which one you are reading. */
function NsChip({ ns }: { ns: string }) {
    return <span style={metaChipStyle('rgba(251,191,36,0.35)', '#fcd34d')}>{ns}</span>;
}

/**
 * The `[[wikilinks]]` in this memory that went nowhere.
 *
 * Ambiguity now resolves to NOTHING rather than to whichever memory happened to
 * be scanned last, which is safer only if the drop is VISIBLE — a graph that
 * quietly gets sparser is the failure the rule was meant to prevent, wearing the
 * fix's clothes. `missing` is normal and says so: a forward reference links up on
 * its own once the target exists.
 */
function UnresolvedNotice({ unresolved }: { unresolved: KnowledgeNode['unresolved'] }) {
    const ambiguous = unresolved.filter((u) => u.reason !== 'missing');
    if (ambiguous.length === 0) return null;
    return (
        <div
            style={{
                marginBottom: 16,
                padding: '10px 12px',
                border: '1px solid rgba(251,191,36,0.3)',
                background: 'rgba(251,191,36,0.07)',
                borderRadius: 8,
            }}
        >
            <Text size="xs" style={{ color: '#fcd34d' }}>
                {ambiguous.length === 1
                    ? '1 link on this memory does not resolve.'
                    : `${ambiguous.length} links on this memory do not resolve.`}
            </Text>
            <ul style={{ margin: '6px 0 0', padding: '0 0 0 16px' }}>
                {ambiguous.map((u) => (
                    <li key={`${u.reason}:${u.ref}`} style={{ fontSize: 12, color: '#d4d4d8' }}>
                        <code>[[{u.ref}]]</code>{' '}
                        {u.reason === 'ambiguous'
                            ? `matches ${u.candidates} memories — link by id, or rename one, to say which you meant.`
                            : `exists only outside what this memory may link to (${u.candidates}).`}
                    </li>
                ))}
            </ul>
        </div>
    );
}

/** A labelled row of clickable memory links (walks the graph). */
function LinkGroup({
    label,
    nodes,
    onOpen,
}: {
    label: string;
    nodes: KnowledgeNode[];
    onOpen: (id: string) => void;
}) {
    return (
        <div style={{ marginBottom: 12 }}>
            <Text size="xs" className="text-zinc-500" style={{ textTransform: 'uppercase', letterSpacing: 0.4 }}>
                {label}
            </Text>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 6 }}>
                {nodes.map((n) => (
                    <button
                        key={n.id}
                        type="button"
                        onClick={() => onOpen(n.id)}
                        style={linkChipStyle}
                        title={`Open “${n.title}”`}
                    >
                        {n.title}
                    </button>
                ))}
            </div>
        </div>
    );
}

/** Add / edit a memory via the react-fancy markdown Editor. */
function MemoryEditor({
    initial,
    workspaces,
    busy,
    onCancel,
    onSave,
}: {
    initial: {
        id?: string;
        title: string;
        tags: string[];
        body: string;
        class: MemoryClass;
        scope: KnowledgeScope;
    };
    workspaces: WorkspaceRow[];
    busy: boolean;
    onCancel: () => void;
    onSave: (draft: {
        id?: string;
        title: string;
        tags: string[];
        body: string;
        class: MemoryClass;
        scope: KnowledgeScope;
    }) => void;
}) {
    const [title, setTitle] = useState(initial.title);
    const [tags, setTags] = useState<string[]>(initial.tags);
    const [body, setBody] = useState(initial.body);
    const [memoryClass, setMemoryClass] = useState<MemoryClass>(initial.class);
    // One flat picker rather than a kind + a ref: "which scope" and "which
    // workspace" are one decision to the person making it, and splitting them
    // into two controls invents a state (kind=workspace, ref=none) that cannot
    // be saved.
    const [scopeValue, setScopeValue] = useState<string>(scopePickerValue(initial.scope));

    const scopeOptions = [
        { value: 'system', label: 'Workstation — every agent, every workspace' },
        ...workspaces.map((w) => ({
            value: `workspace:${w.id}`,
            label: `Workspace — ${w.project_name}`,
        })),
        // A gapp scope is not offered: a GApp's internal memory is written by
        // that app, and a picker listing apps the human is not inside would be
        // offering a filing cabinet nobody opens. An existing one is preserved
        // below rather than silently rewritten.
        ...(initial.scope.kind === 'gapp'
            ? [
                  {
                      value: `gapp:${initial.scope.appId}`,
                      label: `Genie App — ${initial.scope.appId}`,
                  },
              ]
            : []),
    ];

    const canSave = title.trim().length > 0 && !busy;
    const submit = () => {
        if (!canSave) return;
        onSave({
            id: initial.id,
            title: title.trim(),
            tags,
            body,
            class: memoryClass,
            scope: parseKnowledgeScopeValue(scopeValue),
        });
    };

    return (
        <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
            <div
                style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    padding: '14px 20px',
                    borderBottom: BORDER,
                    flex: '0 0 auto',
                }}
            >
                <Heading as="h2" size="sm">
                    {initial.id ? 'Edit memory' : 'New memory'}
                </Heading>
                <span style={{ flex: 1 }} />
                <button type="button" style={secondaryBtnStyle} onClick={onCancel} disabled={busy}>
                    Cancel
                </button>
                <button
                    type="button"
                    style={{ ...primaryBtnStyle, opacity: canSave ? 1 : 0.5 }}
                    onClick={submit}
                    disabled={!canSave}
                >
                    {busy ? 'Saving…' : 'Save'}
                </button>
            </div>

            <div style={{ padding: '14px 20px 8px', flex: '0 0 auto', display: 'flex', flexDirection: 'column', gap: 10 }}>
                <input
                    value={title}
                    onChange={(e) => setTitle(e.target.value)}
                    placeholder="Title"
                    style={{ ...fieldStyle, fontSize: 15, fontWeight: 600 }}
                    aria-label="Memory title"
                    autoFocus
                />
                <Pillbox
                    value={tags}
                    onChange={setTags}
                    placeholder="Add a tag and press Enter…"
                />
                <div style={{ display: 'flex', gap: 8 }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                        <Text size="xs" className="text-zinc-500">
                            Kind of memory
                        </Text>
                        <Select
                            value={memoryClass}
                            onValueChange={(v) => setMemoryClass(v as MemoryClass)}
                            list={CLASS_OPTIONS.filter((o) => o.value !== 'all')}
                        />
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                        <Text size="xs" className="text-zinc-500">
                            Whose reasoning it belongs in
                        </Text>
                        <Select value={scopeValue} onValueChange={setScopeValue} list={scopeOptions} />
                    </div>
                </div>
                <Text size="xs" className="text-zinc-500">
                    Link to another memory by its title with {'[[Memory Title]]'} — resolved
                    links become graph edges. A title that matches several memories links to
                    none of them; link by id to say which you meant.
                </Text>
            </div>

            <div
                style={{
                    flex: 1,
                    minHeight: 0,
                    margin: '0 20px 16px',
                    border: BORDER,
                    borderRadius: 8,
                    overflow: 'hidden',
                    display: 'flex',
                    flexDirection: 'column',
                }}
            >
                <Suspense
                    fallback={
                        <div style={{ padding: 16, color: '#71717a', fontSize: 13 }}>Loading editor…</div>
                    }
                >
                    <DocumentEditorLazy value={body} onChange={setBody} />
                </Suspense>
            </div>
        </div>
    );
}

// --- styles ----------------------------------------------------------------

/** A small outlined chip for a node's scope / class / namespace. */
function metaChipStyle(border: string, color: string): CSSProperties {
    return {
        display: 'inline-flex',
        alignItems: 'center',
        padding: '1px 6px',
        borderRadius: 999,
        border: `1px solid ${border}`,
        color,
        fontSize: 10,
        lineHeight: '15px',
        whiteSpace: 'nowrap',
    };
}


const primaryBtnStyle: CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    padding: '6px 12px',
    borderRadius: 8,
    border: '1px solid rgba(167,139,250,0.5)',
    background: 'rgba(167,139,250,0.18)',
    color: '#ede9fe',
    fontSize: 12,
    cursor: 'pointer',
};

const secondaryBtnStyle: CSSProperties = {
    padding: '6px 12px',
    borderRadius: 8,
    border: BORDER,
    background: 'transparent',
    color: '#d4d4d8',
    fontSize: 12,
    cursor: 'pointer',
};

const dangerBtnStyle: CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    padding: '6px 10px',
    borderRadius: 8,
    border: '1px solid rgba(244,63,94,0.35)',
    background: 'transparent',
    color: '#fda4af',
    cursor: 'pointer',
};

const searchWrapStyle: CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 7,
    padding: '6px 10px',
    borderRadius: 8,
    border: BORDER,
    background: 'rgba(255,255,255,0.03)',
    color: '#a1a1aa',
};

const searchInputStyle: CSSProperties = {
    flex: 1,
    border: 'none',
    outline: 'none',
    background: 'transparent',
    color: '#fafafa',
    fontSize: 13,
};

const clearBtnStyle: CSSProperties = {
    border: 'none',
    background: 'transparent',
    color: '#71717a',
    cursor: 'pointer',
    display: 'inline-flex',
    padding: 0,
};

const listItemStyle: CSSProperties = {
    width: '100%',
    textAlign: 'left',
    display: 'flex',
    flexDirection: 'column',
    padding: '8px 10px',
    marginTop: 2,
    borderRadius: 8,
    border: 'none',
    cursor: 'pointer',
    color: '#e4e4e7',
};

const listTitleStyle: CSSProperties = {
    fontSize: 13,
    fontWeight: 500,
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
};

const snippetStyle: CSSProperties = {
    fontSize: 11,
    color: '#a1a1aa',
    marginTop: 2,
    display: '-webkit-box',
    WebkitLineClamp: 2,
    WebkitBoxOrient: 'vertical',
    overflow: 'hidden',
};

const mutedRowStyle: CSSProperties = {
    padding: '10px 16px',
    fontSize: 12,
    color: '#71717a',
};

const emptyPaneStyle: CSSProperties = {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    color: '#52525b',
};

const fieldStyle: CSSProperties = {
    width: '100%',
    padding: '8px 10px',
    borderRadius: 8,
    border: BORDER,
    background: 'rgba(255,255,255,0.03)',
    color: '#fafafa',
    fontSize: 13,
    outline: 'none',
};

const linkChipStyle: CSSProperties = {
    padding: '4px 10px',
    borderRadius: 999,
    border: '1px solid rgba(167,139,250,0.4)',
    background: 'rgba(167,139,250,0.10)',
    color: '#c4b5fd',
    fontSize: 12,
    cursor: 'pointer',
};

function sourceBadgeStyle(source: KnowledgeNode['source']): CSSProperties {
    const agent = source === 'agent';
    return {
        padding: '1px 8px',
        borderRadius: 999,
        fontSize: 11,
        border: BORDER,
        background: agent ? 'rgba(56,189,248,0.12)' : 'rgba(167,139,250,0.14)',
        color: agent ? '#7dd3fc' : '#c4b5fd',
    };
}
