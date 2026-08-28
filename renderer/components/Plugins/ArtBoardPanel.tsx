import { useCallback, useEffect, useMemo, useState } from 'react';
import { Action, Badge, Card, Heading, Text, Textarea } from '@particle-academy/react-fancy';
import {
    ArtBoard as FancyArtBoard,
    type ArtBoardValue,
} from '@particle-academy/fancy-artboard';
import type { ComponentProps } from 'react';
import { api, type WorkspaceRow } from '../../lib/genie';
import { resolveActiveBoardPost, type BoardPost } from '../../lib/artboard-model';

/**
 * The first-party ArtBoard PANEL adapter — what the plugin's declared
 * `ArtBoardPanel` export resolves to through the compile-time registry.
 *
 * Built only from vetted, Genie-bundled react-fancy primitives (Card, Heading,
 * Text, Badge, Textarea, Action). The plugin ships no UI code; this is the seam.
 *
 * WHY THE PREVIEW IS AN IFRAME AND NOT A COMPONENT: a post's HTML is written by
 * an agent, so it is third-party content inside Genie's renderer. It renders in
 * a `sandbox`ed frame with no `allow-same-origin` and no `allow-scripts`, which
 * is the same isolation rule a GApp window follows — a mockup is for LOOKING at,
 * and nothing it contains needs to execute to be reviewed. That is a security
 * boundary rather than a piece of UI, so it is not something Fancy would own.
 */

interface Props {
    workspace?: WorkspaceRow | null;
    fallbackRoot?: string | null;
    requestedPostId?: string;
}

/** What a post is waiting for, said in one word. */
type BadgeColor = NonNullable<ComponentProps<typeof Badge>['color']>;

function statusOf(post: BoardPost): { label: string; color: BadgeColor } {
    if (!post.review) return { label: 'Awaiting review', color: 'amber' };
    return post.review.verdict === 'approved'
        ? { label: 'Approved', color: 'emerald' }
        : { label: 'Rejected', color: 'rose' };
}

export default function ArtBoardPanel({ workspace, requestedPostId }: Props) {
    const [posts, setPosts] = useState<BoardPost[] | null>(null);
    const [error, setError] = useState<string | null>(null);
    /** Per-post comment drafts. Keyed by id so two open cards do not share one. */
    const [comments, setComments] = useState<Record<string, string>>({});
    /** The post with a verdict in flight — one at a time. */
    const [busy, setBusy] = useState<string | null>(null);
    const [notice, setNotice] = useState<string | null>(null);
    const [selectedPostId, setSelectedPostId] = useState<string | null>(requestedPostId ?? null);

    const workspaceId = workspace?.id ?? null;

    const refresh = useCallback(() => {
        if (!workspaceId) {
            setPosts([]);
            return;
        }
        void api()
            .devServer.artboardRead(workspaceId)
            .then((r) => {
                setPosts(r.posts);
                setError(r.error ?? null);
            })
            .catch((e: unknown) => {
                setPosts([]);
                setError(e instanceof Error ? e.message : String(e));
            });
    }, [workspaceId]);

    useEffect(refresh, [refresh]);
    useEffect(() => {
        if (requestedPostId) setSelectedPostId(requestedPostId);
    }, [requestedPostId]);

    const decide = async (post: BoardPost, verdict: 'approved' | 'rejected') => {
        if (!workspaceId) return;
        setBusy(post.id);
        setError(null);
        setNotice(null);
        try {
            const comment = comments[post.id]?.trim();
            const res = await api().devServer.artboardReview(workspaceId, post.id, {
                verdict,
                ...(comment ? { comment } : {}),
            });
            if (!res.ok) {
                setError(res.error ?? 'The verdict was not recorded.');
                return;
            }
            // NAME whether the agent actually heard it. A verdict recorded but
            // undelivered (its terminal has closed) is a success with a caveat,
            // and reporting it as a clean success would imply someone is acting
            // on it.
            setNotice(
                res.delivered
                    ? `“${post.title}” ${verdict}. The agent has been told.`
                    : `“${post.title}” ${verdict}, and recorded on the board — but the agent that posted it is no longer running, so nothing was delivered.`,
            );
            setComments((c) => ({ ...c, [post.id]: '' }));
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        } finally {
            setBusy(null);
            refresh();
        }
    };

    const boardPosts = posts ?? [];
    const activePost = resolveActiveBoardPost(boardPosts, selectedPostId ?? requestedPostId);
    const boardValue = useMemo<ArtBoardValue>(() => ({
        sections: [{
            id: 'review',
            title: 'Artifacts for review',
            subtitle: `${boardPosts.length} artifact${boardPosts.length === 1 ? '' : 's'}`,
            pieces: boardPosts.map((post) => ({
                id: post.id,
                label: post.title,
                width: 720,
                height: 440,
                content: post.kind === 'image'
                    ? { kind: 'image' as const, src: post.src ?? '', alt: post.title }
                    : { kind: 'html' as const, html: post.html ?? '' },
                origin: 'agent' as const,
                pending: post.review?.verdict !== 'approved',
            })),
        }],
    }), [boardPosts]);

    if (posts === null) return <Text as="p" size="xs" color="muted">Loading the board…</Text>;

    return (
        <div className="artboard">
            {error && (
                <Text as="p" size="xs" color="muted" data-testid="artboard-error">
                    {error}
                </Text>
            )}
            {notice && (
                <Text as="p" size="xs" color="muted" data-testid="artboard-notice">
                    {notice}
                </Text>
            )}

            {posts.length === 0 && (
                <Text as="p" size="xs" color="muted">
                    Nothing posted yet. An agent puts a mockup or an image here with{' '}
                    <code>artboard.post</code> when it wants you to look at something it made.
                </Text>
            )}

            {posts.length > 0 && (
                <div className="artboard-workbench">
                    <FancyArtBoard
                        value={boardValue}
                        focus={activePost?.id ?? null}
                        onFocusChange={setSelectedPostId}
                        htmlPolicy={{ pending: 'sandbox', accepted: 'sanitize' }}
                        style={{ height: 'min(620px, 68vh)', minHeight: 420 }}
                    />
                    {activePost && <ArtBoardArtifact
                        post={activePost}
                        comment={comments[activePost.id] ?? ''}
                        busy={busy !== null}
                        onComment={(value) => setComments((current) => ({
                            ...current,
                            [activePost.id]: value,
                        }))}
                        onDecide={(verdict) => void decide(activePost, verdict)}
                    />}
                </div>
            )}
        </div>
    );
}

function ArtBoardArtifact({
    post,
    comment,
    busy,
    onComment,
    onDecide,
}: {
    post: BoardPost;
    comment: string;
    busy: boolean;
    onComment: (value: string) => void;
    onDecide: (verdict: 'approved' | 'rejected') => void;
}) {
                const status = statusOf(post);
                return (
                    <Card data-testid="artboard-post">
                        <Heading as="h3" size="sm">
                            {post.title}
                        </Heading>
                        <Badge color={status.color} size="sm" variant="soft">
                            {status.label}
                        </Badge>
                        {post.note && (
                            <Text as="p" size="xs" color="muted">
                                {post.note}
                            </Text>
                        )}

                        {post.review ? (
                            <Text as="p" size="xs" color="muted">
                                {post.review.verdict === 'approved' ? 'Approved' : 'Rejected'}
                                {post.review.comment ? ` — ${post.review.comment}` : ' with no comment.'}
                            </Text>
                        ) : (
                            <>
                                <Textarea
                                    aria-label={`Comment on ${post.title}`}
                                    placeholder="Optional comment — what should change, or why this is right."
                                    value={comment}
                                    onChange={(e: { target: { value: string } }) =>
                                        onComment(e.target.value)
                                    }
                                />
                                <Action
                                    icon="check"
                                    disabled={busy}
                                    onClick={() => onDecide('approved')}
                                >
                                    Approve
                                </Action>
                                <Action
                                    icon="x"
                                    disabled={busy}
                                    onClick={() => onDecide('rejected')}
                                >
                                    Reject
                                </Action>
                            </>
                        )}
                    </Card>
                );
}
