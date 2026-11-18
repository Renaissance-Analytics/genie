import { useCallback, useEffect, useRef, useState } from 'react';
import { Badge, Button, Card, ContentRenderer, Modal, Textarea } from '@particle-academy/react-fancy';
import { timelineOf, visiblePosts, type BoardFilter, type ClearScope, type DisplayPost, type DisplayVersion } from '../../core/artboard.js';
import type { GenieBridge } from '../bridge.js';
import { genieClipboardWriter } from '../clipboard.js';

/**
 * THE ARTBOARD (beta.33 item 14, Tynn #784; Genie 1 renderer/components/Plugins/ArtBoardPanel.tsx; a tab of its own, Tynn
 * #739) — where a person looks at what agents MADE. Each item: its title and note, the artifact itself (HTML in a SANDBOXED
 * frame — no script, no same origin: an agent's markup is untrusted — an image, or a Markdown / PDF document), and, ONLY when
 * the item asked for a verdict (genie#1275), Approve / Reject with a comment. The verdict is written on the item and delivered
 * to the agent that posted it, in its AgentInbox. The board follows the disk (the host's push).
 *
 * THE TRAIL (#739). An item keeps every version (re-posting an id adds one; any two can be compared side by side), who posted
 * it, every verdict with its comment and every reply from the agent. The default view is WAITING: a decided item hides
 * unless the person PINNED it; Decided and All show the rest. An item a link points at is shown whatever its status.
 *
 * SIZE (genie#1275 — the owner: "Artboard cards should size to the panel."). The panel is a size container; cards sit in an
 * auto-FIT grid whose minimum track is min(100%, 36rem). One card spans the whole panel (auto-fill kept empty tracks, so a
 * single post was a ~400 px column); a panel wider than two minimums shows posts side by side at >= 36rem each — wide enough
 * for a mockup laid out for a real viewport; narrower, it is one full-width column. A preview's height comes from the PANEL
 * (container units): an image keeps its own height up to the panel's; an HTML frame is the panel's height, because a frame
 * with no script and no same origin cannot report its content height and the sandbox is not loosened to learn it. An HTML
 * item posted WITH the size it was made for is shown at that size instead, scaled to fit with a zoom. Either opens full size.
 */

/** The content of one version, laid over its post: what the previewer draws. */
function viewOf(post: DisplayPost, version: DisplayVersion | undefined): DisplayPost {
    if (!version) return post;
    const { html: _html, src: _src, text: _text, contentError: _error, ...rest } = post;
    return {
        ...rest,
        kind: version.kind,
        ...(version.html !== undefined ? { html: version.html } : {}),
        ...(version.src !== undefined ? { src: version.src } : {}),
        ...(version.text !== undefined ? { text: version.text } : {}),
        ...(version.contentError !== undefined ? { contentError: version.contentError } : {}),
    };
}

const ZOOMS = ['fit', 0.5, 1] as const;
type Zoom = (typeof ZOOMS)[number];
const zoomLabel = (z: Zoom) => (z === 'fit' ? 'Fit' : `${z * 100}%`);

/** HTML at the size it was made for: the iframe is that size, scaled to the panel (Fit) or to a fixed zoom. */
function SizedFrame({ post, width, height, full }: { readonly post: DisplayPost; readonly width: number; readonly height: number; readonly full: boolean }) {
    const [zoom, setZoom] = useState<Zoom>('fit');
    const [box, setBox] = useState(0);
    const area = useRef<HTMLDivElement>(null);
    useEffect(() => {
        const el = area.current;
        if (!el || typeof ResizeObserver === 'undefined') return;
        const watch = new ResizeObserver((entries) => setBox(entries[0]?.contentRect.width ?? 0));
        watch.observe(el);
        return () => watch.disconnect();
    }, []);
    const scale = zoom === 'fit' ? (box > 0 ? Math.min(1, box / width) : 1) : zoom;
    return (
        <div data-artboard-sized="" data-artboard-frame-size={`${width}x${height}`} className={`flex flex-col ${full ? 'h-full' : ''}`}>
            <div className="flex shrink-0 items-center gap-1 border-b border-[var(--border-1)] bg-[var(--bg-1)] p-1">
                <span className="mr-1 font-mono text-[11px] text-[var(--fg-4)]">{width} × {height}</span>
                {ZOOMS.map((z) => (
                    <Button key={String(z)} size="xs" variant={zoom === z ? 'default' : 'ghost'} data-artboard-zoom={String(z)} aria-pressed={zoom === z ? 'true' : 'false'} onClick={() => setZoom(z)}>{zoomLabel(z)}</Button>
                ))}
            </div>
            <div ref={area} className={`w-full overflow-auto ${full ? 'min-h-0 flex-1' : ''}`} {...(full ? {} : { style: { height: Math.ceil(height * scale) } })}>
                <div style={{ width: Math.ceil(width * scale), height: Math.ceil(height * scale) }}>
                    <iframe title={post.title} sandbox="" srcDoc={post.html ?? ''} className="block border-0 bg-white" style={{ width, height, transform: `scale(${scale})`, transformOrigin: '0 0' }} />
                </div>
            </div>
        </div>
    );
}

/**
 * The artifact, in a card or full size. The sandbox lives HERE only, so both views share it exactly. In a card its ceiling
 * is the panel's height less the card's header and padding — written out literally, as Tailwind only builds the classes it
 * can read in the source.
 */
export function ArtifactPreview({ post, full = false }: { readonly post: DisplayPost; readonly full?: boolean }) {
    if (post.contentError) return <p role="alert" className="p-3 text-xs text-[var(--warning)]">{post.contentError}</p>;
    if (post.kind === 'html') {
        if (post.width && post.height) return <SizedFrame post={post} width={post.width} height={post.height} full={full} />;
        return <iframe title={post.title} sandbox="" srcDoc={post.html ?? ''} className={full ? 'block h-full w-full border-0' : 'block h-[max(16rem,calc(100cqh_-_6rem))] w-full border-0'} />;
    }
    if (post.kind === 'markdown') {
        return (
            <div data-artboard-doc="markdown" className={`overflow-auto bg-[var(--bg-1)] p-4 text-[var(--fg-1)] ${full ? 'h-full' : 'max-h-[max(16rem,calc(100cqh_-_6rem))]'}`}>
                <ContentRenderer clipboardWriter={genieClipboardWriter} value={post.text ?? ''} format="markdown" />
            </div>
        );
    }
    if (post.kind === 'pdf') {
        return (
            <object data-artboard-doc="pdf" data={post.src} type="application/pdf" aria-label={post.title} className={`block w-full border-0 ${full ? 'h-full' : 'h-[max(16rem,calc(100cqh_-_6rem))]'}`}>
                <p className="p-3 text-xs text-[var(--fg-3)]">This PDF could not be shown here.</p>
            </object>
        );
    }
    return <img alt={post.title} src={post.src} className={full ? 'block h-full w-full object-contain' : 'mx-auto block h-auto w-full max-h-[max(16rem,calc(100cqh_-_6rem))] object-contain'} />;
}

export interface ArtBoardViewProps {
    readonly posts: readonly DisplayPost[];
    readonly error: string | null;
    readonly onReview: (postId: string, verdict: 'approved' | 'rejected', comment: string) => void;
    /** Keep an item in the default view after its verdict, or let it hide. Absent = no pin is offered (a board that cannot keep one). */
    readonly onPin?: ((postId: string, pinned: boolean) => void) | undefined;
    /** Clear the board, after the person confirmed (genie#847). Absent = no Clear menu (a board that cannot clear). */
    readonly onClear?: ((scope: ClearScope) => void) | undefined;
    /** Take one item off the board into .trash (genie#847). Absent = no Delete on the cards. */
    readonly onDelete?: ((postId: string) => void) | undefined;
    readonly busy?: string | null | undefined;
    /** The item a link points at: shown, and scrolled to, whatever its status. */
    readonly focusId?: string | null | undefined;
    readonly initialFilter?: BoardFilter | undefined;
    /** Open this item with its versions side by side (a test seam; the person clicks Compare). */
    readonly initialCompare?: string | null | undefined;
}

const when = (iso: string) => new Date(iso).toLocaleString();
const FILTERS: readonly { readonly id: BoardFilter; readonly label: string }[] = [{ id: 'waiting', label: 'Waiting' }, { id: 'decided', label: 'Decided' }, { id: 'all', label: 'All' }];

/** What happened to an item, oldest first: each version posted, each verdict and its comment, each reply. */
function Trail({ post, open }: { readonly post: DisplayPost; readonly open: boolean }) {
    const versions = post.versions?.map((v) => ({ n: v.n, createdAt: v.createdAt, by: v.poster, note: v.note })) ?? [{ n: 1, createdAt: post.createdAt, by: post.poster, note: post.note }];
    const events = timelineOf(versions, post.trail ?? []);
    return (
        <details data-artboard-trail="" open={open} className="rounded-md border border-[var(--border-1)] px-2 py-1 text-xs">
            <summary className="cursor-default select-none text-[var(--fg-2)]">Trail · {events.length} event{events.length === 1 ? '' : 's'}</summary>
            <ol className="mt-1 flex flex-col gap-1">
                {events.map((e, i) => (
                    <li key={i} data-trail-event={e.kind} className="flex flex-col text-[var(--fg-2)]">
                        <span className="font-mono text-[11px] text-[var(--fg-4)]">
                            v{e.version} · {e.kind === 'version' ? `posted${e.by ? ` by ${e.by}` : ''}` : e.kind === 'verdict' ? `${e.verdict}${e.by ? ` by ${e.by}` : ''}` : `${e.by ?? 'agent'} replied`} · {when(e.at)}
                        </span>
                        {e.kind === 'version' ? (e.note ? <span>{e.note}</span> : null) : e.kind === 'verdict' ? (e.comment ? <span>“{e.comment}”</span> : null) : <span>{e.text}</span>}
                    </li>
                ))}
            </ol>
        </details>
    );
}

function PostCard({ post: p, focused, busy, onReview, onPin, onFull, initialCompare }: { readonly post: DisplayPost; readonly focused: boolean; readonly busy: boolean; readonly onReview: ArtBoardViewProps['onReview']; readonly onPin: ArtBoardViewProps['onPin']; readonly onFull: () => void; readonly initialCompare: boolean }) {
    const versions = p.versions ?? [];
    const latest = versions[versions.length - 1]?.n ?? 1;
    const [comment, setComment] = useState('');
    const [shownN, setShownN] = useState(latest);
    const [compare, setCompare] = useState(initialCompare && versions.length > 1);
    const [againstN, setAgainstN] = useState(versions.length > 1 ? (versions[versions.length - 2]?.n ?? 1) : 1);
    const wrap = useRef<HTMLDivElement>(null);
    // A link that points here brings it into view (the owner: one click, never "it's on your ArtBoard").
    useEffect(() => { if (focused) wrap.current?.scrollIntoView?.({ block: 'nearest' }); }, [focused]);
    const find = (n: number) => versions.find((v) => v.n === n);
    const shown = viewOf(p, find(shownN));
    const against = viewOf(p, find(againstN));
    const meta = (v: DisplayVersion | undefined) => (v ? `v${v.n} · ${when(v.createdAt)}${v.poster ? ` · ${v.poster}` : ''}` : '');
    return (
        <div ref={wrap} className="min-w-0">
            <Card data-artboard-post={p.id} data-ask-verdict={p.askVerdict ? 'true' : 'false'} {...(p.review ? { 'data-verdict': p.review.verdict } : {})} {...(focused ? { 'data-artboard-focus': 'true' } : {})} className={`flex min-w-0 flex-col gap-2 p-3 ${focused ? 'ring-2 ring-[var(--accent)]' : ''}`}>
                <div className="flex items-center gap-2">
                    <span className="truncate font-medium">{p.title}</span>
                    {p.review ? <Badge size="sm" variant="soft" color={p.review.verdict === 'approved' ? 'emerald' : 'red'}>{p.review.verdict}</Badge> : p.askVerdict ? <Badge size="sm" variant="outline">awaiting review</Badge> : null}
                    {versions.length > 1 ? <Badge size="sm" variant="outline">v{latest}</Badge> : null}
                    <span className="ml-auto shrink-0 font-mono text-[11px] text-[var(--fg-4)]">{when(p.createdAt)}</span>
                    {onPin ? (
                        <Button size="xs" variant={p.pinned ? 'default' : 'ghost'} icon="pin" data-action="artboard-pin" aria-pressed={p.pinned ? 'true' : 'false'} aria-label={p.pinned ? `Unpin ${p.title}` : `Pin ${p.title} to keep it in view after a verdict`} title={p.pinned ? 'Pinned: stays in view after a verdict. Click to unpin.' : 'Pin: keep it in view after a verdict'} onClick={() => onPin(p.id, !p.pinned)}>{p.pinned ? 'Pinned' : 'Pin'}</Button>
                    ) : null}
                    <Button size="xs" variant="ghost" icon="maximize-2" data-action="artboard-full" aria-label={`Open ${p.title} full size`} title="Open full size" onClick={onFull} />
                </div>
                {p.note && versions.length <= 1 ? <p className="text-xs text-[var(--fg-2)]">{p.note}</p> : null}
                {versions.length > 1 ? (
                    <div data-artboard-versions="" className="flex flex-wrap items-center gap-1">
                        <span className="text-[11px] text-[var(--fg-3)]">{compare ? 'Newer' : 'Version'}</span>
                        {versions.map((v) => (
                            <Button key={v.n} size="xs" variant={v.n === shownN ? 'default' : 'ghost'} data-artboard-version={String(v.n)} aria-pressed={v.n === shownN ? 'true' : 'false'} title={meta(v)} onClick={() => setShownN(v.n)}>v{v.n}</Button>
                        ))}
                        {compare ? (
                            <>
                                <span className="ml-2 text-[11px] text-[var(--fg-3)]">Against</span>
                                {versions.map((v) => (
                                    <Button key={v.n} size="xs" variant={v.n === againstN ? 'default' : 'ghost'} data-artboard-against={String(v.n)} aria-pressed={v.n === againstN ? 'true' : 'false'} title={meta(v)} onClick={() => setAgainstN(v.n)}>v{v.n}</Button>
                                ))}
                            </>
                        ) : null}
                        <Button size="xs" variant="ghost" data-action="artboard-compare" aria-pressed={compare ? 'true' : 'false'} onClick={() => setCompare((c) => !c)}>{compare ? 'Single view' : 'Compare side by side'}</Button>
                    </div>
                ) : null}
                {compare && versions.length > 1 ? (
                    <div data-artboard-compare="" className="grid grid-cols-2 gap-2">
                        {[{ n: againstN, view: against }, { n: shownN, view: shown }].map((side, i) => (
                            <div key={i} className="flex min-w-0 flex-col gap-1">
                                <span className="font-mono text-[11px] text-[var(--fg-4)]">{meta(find(side.n))}</span>
                                <div className="overflow-hidden rounded-md border border-[var(--border-1)] bg-white"><ArtifactPreview post={side.view} /></div>
                            </div>
                        ))}
                    </div>
                ) : (
                    <div className="overflow-hidden rounded-md border border-[var(--border-1)] bg-white">
                        <ArtifactPreview post={shown} />
                    </div>
                )}
                {p.review?.comment ? <p className="text-xs text-[var(--fg-3)]">“{p.review.comment}”</p> : null}
                {p.versions || (p.trail && p.trail.length > 0) ? <Trail post={p} open={focused} /> : null}
                {p.askVerdict ? (
                    <>
                        <Textarea aria-label={`Comment on ${p.title}`} placeholder="Comment (optional)" rows={2} value={comment} onValueChange={setComment} />
                        <div className="flex gap-2">
                            <Button size="sm" color="emerald" icon="check" data-action="artboard-approve" aria-label={`Approve ${p.title}`} title="Approve" disabled={busy} onClick={() => onReview(p.id, 'approved', comment)} />
                            <Button size="sm" color="red" variant="ghost" icon="x" data-action="artboard-reject" aria-label={`Reject ${p.title}`} title="Reject" disabled={busy} onClick={() => onReview(p.id, 'rejected', comment)} />
                        </div>
                    </>
                ) : null}
            </Card>
        </div>
    );
}

export function ArtBoardView({ posts, error, onReview, onPin, busy = null, focusId = null, initialFilter = 'waiting', initialCompare = null }: ArtBoardViewProps) {
    const [filter, setFilter] = useState<BoardFilter>(initialFilter);
    const [fullId, setFullId] = useState<string | null>(null);
    const full = fullId ? posts.find((p) => p.id === fullId) ?? null : null;
    const shown = visiblePosts(posts, filter, focusId);
    const counts: Record<BoardFilter, number> = { waiting: visiblePosts(posts, 'waiting').length, decided: visiblePosts(posts, 'decided').length, all: posts.length };
    return (
        <section data-artboard="" className="flex h-full min-h-0 flex-1 flex-col overflow-auto p-3 text-[13px] [container-type:size]">
            {error ? <p data-artboard-error="" className="mb-2 text-xs text-[var(--warning)]">{error}</p> : null}
            {posts.length === 0 ? (
                <p className="text-[var(--fg-3)]">Nothing on the board yet. When an agent posts a mockup, a page, an image or a document (artboard.post), it shows here, and everything decided about it is kept.</p>
            ) : (
                <>
                    <div data-artboard-filters="" role="group" aria-label="Show" className="mb-3 flex shrink-0 items-center gap-1">
                        {FILTERS.map((f) => (
                            <Button key={f.id} size="xs" variant={filter === f.id ? 'default' : 'ghost'} data-artboard-filter={f.id} aria-pressed={filter === f.id ? 'true' : 'false'} onClick={() => setFilter(f.id)}>
                                {f.label} <span className="ml-1 font-mono text-[11px] text-[var(--fg-4)]">{counts[f.id]}</span>
                            </Button>
                        ))}
                    </div>
                    {shown.length === 0 ? (
                        <p data-artboard-none="" className="text-[var(--fg-3)]">
                            {filter === 'waiting' ? `Nothing is waiting for you. ${counts.decided} decided item${counts.decided === 1 ? ' is' : 's are'} under Decided and All; pin one to keep it here.` : 'Nothing decided yet.'}
                        </p>
                    ) : (
                        <div data-artboard-grid="" className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,36rem),1fr))] items-start gap-3">
                            {shown.map((p) => (
                                <PostCard key={p.id} post={p} focused={p.id === focusId} busy={busy === p.id} onReview={onReview} onPin={onPin} onFull={() => setFullId(p.id)} initialCompare={initialCompare === p.id} />
                            ))}
                        </div>
                    )}
                </>
            )}
            {full ? (
                <Modal open onClose={() => setFullId(null)} size="full">
                    <Modal.Header>{full.title}</Modal.Header>
                    <Modal.Body>
                        <div data-artboard-full={full.id} className="h-[calc(100dvh-9rem)] w-[calc(100vw-4rem)] max-w-full overflow-hidden rounded-md bg-white">
                            <ArtifactPreview post={full} full />
                        </div>
                    </Modal.Body>
                </Modal>
            ) : null}
        </section>
    );
}

type BoardBridge = NonNullable<GenieBridge['artboard']>;

export function ArtBoardPanel({ workspaceId, artboard, files, focusId = null }: { workspaceId: string; artboard: BoardBridge | undefined; files?: Pick<GenieBridge['files'], 'subscribe'> | undefined; focusId?: string | null | undefined }) {
    const [posts, setPosts] = useState<readonly DisplayPost[] | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState<string | null>(null);
    const read = useCallback(() => {
        if (!artboard) return;
        void artboard.read(workspaceId).then((b) => { setPosts(b.posts); setError(b.error ?? null); }, (e: unknown) => setError(e instanceof Error ? e.message : String(e)));
    }, [artboard, workspaceId]);
    useEffect(() => { read(); }, [read]);
    // A new post lands on disk: the host's watcher pushes it (only changes under .artboard/ re-read the board).
    useEffect(() => {
        if (!files?.subscribe || !artboard) return;
        // This view's subscription (the host split, P2.2): watched while the board is shown, let go when it is not.
        return files.subscribe(workspaceId, {}, (event) => { if (!event.git && (!event.paths || event.paths.some((p) => p.startsWith('.artboard/')))) read(); });
    }, [files, artboard, workspaceId, read]);

    if (!artboard) return <p className="p-4 text-[13px] text-[var(--fg-3)]">This window has no ArtBoard host — the board lives on the machine that holds the workspace.</p>;
    if (posts === null) return <p className="p-4 text-[13px] text-[var(--fg-3)]">Reading the board…</p>;
    const act = (id: string, verdict: 'approved' | 'rejected' | 'pin' | 'unpin', comment: string) => {
        setBusy(id);
        void artboard.review(workspaceId, id, verdict, comment).then((r) => { if (!r.ok) setError(r.error); read(); }).finally(() => setBusy(null));
    };
    return (
        <ArtBoardView
            posts={posts}
            error={error}
            busy={busy}
            focusId={focusId}
            onReview={(id, verdict, comment) => act(id, verdict, comment)}
            onPin={(id, pinned) => act(id, pinned ? 'pin' : 'unpin', '')}
        />
    );
}
