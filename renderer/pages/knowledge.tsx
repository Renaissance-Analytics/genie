import React, {
    Suspense,
    lazy,
    useCallback,
    useEffect,
    useMemo,
    useState,
    type CSSProperties,
} from 'react';
import { ContentRenderer, Heading, Text } from '@particle-academy/react-fancy';
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
    type KnowledgeGraphData,
    type KnowledgeNode,
    type KnowledgeSearchResult,
} from '../lib/genie';
import { circleLayout } from '../lib/knowledge-graph';

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

function truncate(s: string, n: number): string {
    return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/** Split a comma-separated tag input into a trimmed, de-duplicated list. */
function parseTags(raw: string): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const t of raw.split(',')) {
        const v = t.trim();
        if (!v || seen.has(v.toLowerCase())) continue;
        seen.add(v.toLowerCase());
        out.push(v);
    }
    return out;
}

export default function KnowledgePage() {
    const [nodes, setNodes] = useState<KnowledgeNode[]>([]);
    const [graph, setGraph] = useState<KnowledgeGraphData | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    const [query, setQuery] = useState('');
    const [results, setResults] = useState<KnowledgeSearchResult[] | null>(null);

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
            api().knowledge.list(),
            api().knowledge.graph(),
        ]);
        setNodes(ns);
        setGraph(g);
        return ns;
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
                .knowledge.search(q)
                .then(setResults)
                .catch(() => setResults([]));
        }, 200);
        return () => clearTimeout(t);
    }, [query]);

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
        async (draft: { id?: string; title: string; tags: string[]; body: string }) => {
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
                                      }
                                    : { title: '', tags: [], body: '' }
                            }
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
    backlinks,
    onOpen,
    onEdit,
    onDelete,
    busy,
}: {
    node: KnowledgeNode;
    nodesById: Map<string, KnowledgeNode>;
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
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 }}>
                        <span style={sourceBadgeStyle(node.source)}>
                            {node.source === 'agent' ? 'agent' : 'you'}
                        </span>
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
    busy,
    onCancel,
    onSave,
}: {
    initial: { id?: string; title: string; tags: string[]; body: string };
    busy: boolean;
    onCancel: () => void;
    onSave: (draft: { id?: string; title: string; tags: string[]; body: string }) => void;
}) {
    const [title, setTitle] = useState(initial.title);
    const [tags, setTags] = useState(initial.tags.join(', '));
    const [body, setBody] = useState(initial.body);

    const canSave = title.trim().length > 0 && !busy;
    const submit = () => {
        if (!canSave) return;
        onSave({ id: initial.id, title: title.trim(), tags: parseTags(tags), body });
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
                <input
                    value={tags}
                    onChange={(e) => setTags(e.target.value)}
                    placeholder="Tags (comma separated)"
                    style={fieldStyle}
                    aria-label="Tags"
                />
                <Text size="xs" className="text-zinc-500">
                    Link to another memory by its title with {'[[Memory Title]]'} — resolved
                    links become graph edges.
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
