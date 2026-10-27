import { useCallback, useEffect, useState } from 'react';
import { Badge, Button, Card, Modal, Textarea } from '@particle-academy/react-fancy';
import type { DisplayPost } from '../../core/artboard.js';
import type { GenieBridge } from '../bridge.js';

/**
 * THE ARTBOARD (beta.33 item 14, Tynn #784; Genie 1 renderer/components/Plugins/ArtBoardPanel.tsx) — where a person looks at
 * what agents MADE. Each post: its title and note, the artifact itself (HTML in a SANDBOXED frame — no script, no same
 * origin: an agent's markup is untrusted — or the image inline), and, ONLY when the post asked for a verdict (genie#1275),
 * Approve / Reject with a comment. The verdict is written on the post and delivered to the agent that posted it, in its
 * AgentInbox. The board follows the disk (the host's push).
 *
 * SIZE (genie#1275 — the owner: "Artboard cards should size to the panel."). The panel is a size container; cards sit in an
 * auto-FIT grid whose minimum track is min(100%, 36rem). One card spans the whole panel (auto-fill kept empty tracks, so a
 * single post was a ~400 px column); a panel wider than two minimums shows posts side by side at >= 36rem each — wide enough
 * for a mockup laid out for a real viewport; narrower, it is one full-width column. A preview's height comes from the PANEL
 * (container units): an image keeps its own height up to the panel's; an HTML frame is the panel's height, because a frame
 * with no script and no same origin cannot report its content height and the sandbox is not loosened to learn it. Either
 * opens full size.
 */

/**
 * The artifact, in a card or full size. The sandbox lives HERE only, so both views share it exactly. In a card its ceiling
 * is the panel's height less the card's header and padding — written out literally, as Tailwind only builds the classes it
 * can read in the source.
 */
export function ArtifactPreview({ post, full = false }: { readonly post: DisplayPost; readonly full?: boolean }) {
    if (post.kind === 'html') {
        return <iframe title={post.title} sandbox="" srcDoc={post.html ?? ''} className={full ? 'block h-full w-full border-0' : 'block h-[max(16rem,calc(100cqh_-_6rem))] w-full border-0'} />;
    }
    return <img alt={post.title} src={post.src} className={full ? 'block h-full w-full object-contain' : 'mx-auto block h-auto w-full max-h-[max(16rem,calc(100cqh_-_6rem))] object-contain'} />;
}

export interface ArtBoardViewProps {
    readonly posts: readonly DisplayPost[];
    readonly error: string | null;
    readonly onReview: (postId: string, verdict: 'approved' | 'rejected', comment: string) => void;
    readonly busy?: string | null | undefined;
}

export function ArtBoardView({ posts, error, onReview, busy = null }: ArtBoardViewProps) {
    const [comments, setComments] = useState<Record<string, string>>({});
    const [fullId, setFullId] = useState<string | null>(null);
    const full = fullId ? posts.find((p) => p.id === fullId) ?? null : null;
    return (
        <section data-artboard="" className="flex h-full min-h-0 flex-1 flex-col overflow-auto p-3 text-[13px] [container-type:size]">
            {error ? <p data-artboard-error="" className="mb-2 text-xs text-[var(--warning)]">{error}</p> : null}
            {posts.length === 0 ? (
                <p className="text-[var(--fg-3)]">Nothing on the board yet. When an agent posts a mockup or an image (artboard.post), it shows here.</p>
            ) : (
                <div data-artboard-grid="" className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,36rem),1fr))] items-start gap-3">
                    {posts.map((p) => (
                        <Card key={p.id} data-artboard-post={p.id} data-ask-verdict={p.askVerdict ? 'true' : 'false'} {...(p.review ? { 'data-verdict': p.review.verdict } : {})} className="flex min-w-0 flex-col gap-2 p-3">
                            <div className="flex items-center gap-2">
                                <span className="truncate font-medium">{p.title}</span>
                                {p.review ? <Badge size="sm" variant="soft" color={p.review.verdict === 'approved' ? 'emerald' : 'red'}>{p.review.verdict}</Badge> : p.askVerdict ? <Badge size="sm" variant="outline">awaiting review</Badge> : null}
                                <span className="ml-auto shrink-0 font-mono text-[11px] text-[var(--fg-4)]">{new Date(p.createdAt).toLocaleString()}</span>
                                <Button size="xs" variant="ghost" icon="maximize-2" data-action="artboard-full" aria-label={`Open ${p.title} full size`} title="Open full size" onClick={() => setFullId(p.id)} />
                            </div>
                            {p.note ? <p className="text-xs text-[var(--fg-2)]">{p.note}</p> : null}
                            <div className="overflow-hidden rounded-md border border-[var(--border-1)] bg-white">
                                <ArtifactPreview post={p} />
                            </div>
                            {p.review?.comment ? <p className="text-xs text-[var(--fg-3)]">“{p.review.comment}”</p> : null}
                            {p.askVerdict ? (
                                <>
                                    <Textarea aria-label={`Comment on ${p.title}`} placeholder="Comment (optional)" rows={2} value={comments[p.id] ?? ''} onValueChange={(v) => setComments((c) => ({ ...c, [p.id]: v }))} />
                                    <div className="flex gap-2">
                                        <Button size="sm" color="emerald" icon="check" data-action="artboard-approve" aria-label={`Approve ${p.title}`} title="Approve" disabled={busy === p.id} onClick={() => onReview(p.id, 'approved', comments[p.id] ?? '')} />
                                        <Button size="sm" color="red" variant="ghost" icon="x" data-action="artboard-reject" aria-label={`Reject ${p.title}`} title="Reject" disabled={busy === p.id} onClick={() => onReview(p.id, 'rejected', comments[p.id] ?? '')} />
                                    </div>
                                </>
                            ) : null}
                        </Card>
                    ))}
                </div>
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

export function ArtBoardPanel({ workspaceId, artboard, files }: { workspaceId: string; artboard: BoardBridge | undefined; files?: Pick<GenieBridge['files'], 'watch' | 'onChange'> | undefined }) {
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
        if (!files || !artboard) return;
        void files.watch(workspaceId);
        return files.onChange((id, paths) => { if (id === workspaceId && (!paths || paths.some((p) => p.startsWith('.artboard/')))) read(); });
    }, [files, artboard, workspaceId, read]);

    if (!artboard) return <p className="p-4 text-[13px] text-[var(--fg-3)]">This window has no ArtBoard host — the board lives on the machine that holds the workspace.</p>;
    if (posts === null) return <p className="p-4 text-[13px] text-[var(--fg-3)]">Reading the board…</p>;
    return (
        <ArtBoardView
            posts={posts}
            error={error}
            busy={busy}
            onReview={(id, verdict, comment) => {
                setBusy(id);
                void artboard.review(workspaceId, id, verdict, comment).then((r) => { if (!r.ok) setError(r.error); read(); }).finally(() => setBusy(null));
            }}
        />
    );
}
