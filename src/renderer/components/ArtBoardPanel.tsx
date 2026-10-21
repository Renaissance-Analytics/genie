import { useCallback, useEffect, useState } from 'react';
import { Badge, Button, Card, Textarea } from '@particle-academy/react-fancy';
import type { DisplayPost } from '../../core/artboard.js';
import type { GenieBridge } from '../bridge.js';

/**
 * THE ARTBOARD (beta.33 item 14, Tynn #784; Genie 1 renderer/components/Plugins/ArtBoardPanel.tsx) — where a person looks at
 * what agents MADE. Each post: its title and note, the artifact itself (HTML in a SANDBOXED frame — no script, no same
 * origin: an agent's markup is untrusted — or the image inline), and Approve / Reject with a comment. The verdict is written
 * on the post and delivered to the agent that posted it, in its AgentInbox. The board follows the disk (the host's push).
 */

export interface ArtBoardViewProps {
    readonly posts: readonly DisplayPost[];
    readonly error: string | null;
    readonly onReview: (postId: string, verdict: 'approved' | 'rejected', comment: string) => void;
    readonly busy?: string | null | undefined;
}

export function ArtBoardView({ posts, error, onReview, busy = null }: ArtBoardViewProps) {
    const [comments, setComments] = useState<Record<string, string>>({});
    return (
        <section data-artboard="" className="flex h-full min-h-0 flex-col overflow-auto p-3 text-[13px]">
            {error ? <p data-artboard-error="" className="mb-2 text-xs text-[var(--warning)]">{error}</p> : null}
            {posts.length === 0 ? (
                <p className="text-[var(--fg-3)]">Nothing on the board yet. When an agent posts a mockup or an image for review (artboard.post), it shows here.</p>
            ) : (
                <div className="grid grid-cols-[repeat(auto-fill,minmax(320px,1fr))] gap-3">
                    {posts.map((p) => (
                        <Card key={p.id} data-artboard-post={p.id} {...(p.review ? { 'data-verdict': p.review.verdict } : {})} className="flex flex-col gap-2 p-3">
                            <div className="flex items-center gap-2">
                                <span className="font-medium">{p.title}</span>
                                {p.review ? <Badge size="sm" variant="soft" color={p.review.verdict === 'approved' ? 'emerald' : 'red'}>{p.review.verdict}</Badge> : <Badge size="sm" variant="outline">awaiting review</Badge>}
                                <span className="ml-auto font-mono text-[11px] text-[var(--fg-4)]">{new Date(p.createdAt).toLocaleString()}</span>
                            </div>
                            {p.note ? <p className="text-xs text-[var(--fg-2)]">{p.note}</p> : null}
                            <div className="h-64 overflow-hidden rounded-md border border-[var(--border-1)] bg-white">
                                {p.kind === 'html' ? (
                                    <iframe title={p.title} sandbox="" srcDoc={p.html ?? ''} className="h-full w-full border-0" />
                                ) : (
                                    <img alt={p.title} src={p.src} className="h-full w-full object-contain" />
                                )}
                            </div>
                            {p.review?.comment ? <p className="text-xs text-[var(--fg-3)]">“{p.review.comment}”</p> : null}
                            <Textarea aria-label={`Comment on ${p.title}`} placeholder="A comment for the agent (optional)" rows={2} value={comments[p.id] ?? ''} onValueChange={(v) => setComments((c) => ({ ...c, [p.id]: v }))} />
                            <div className="flex gap-2">
                                <Button size="sm" color="emerald" data-action="artboard-approve" disabled={busy === p.id} onClick={() => onReview(p.id, 'approved', comments[p.id] ?? '')}>Approve</Button>
                                <Button size="sm" color="red" variant="ghost" data-action="artboard-reject" disabled={busy === p.id} onClick={() => onReview(p.id, 'rejected', comments[p.id] ?? '')}>Reject</Button>
                            </div>
                        </Card>
                    ))}
                </div>
            )}
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
