import { createContext, useContext, useEffect, useState } from 'react';
import { Button } from '@particle-academy/react-fancy';
import type { DisplayPost } from '../../core/artboard.js';
import { visualsOfQuestion, type QuestionVisual } from '../../core/question-visuals.js';
import type { Question } from '../../core/attention.js';
import { ArtifactPreview } from './ArtBoardPanel.js';

/**
 * A QUESTION'S VISUALS IN THE QUESTION WINDOW (Tynn #835; core/question-visuals.ts). Each visual is an ArtBoard post, drawn
 * by the ArtBoard tab's own `ArtifactPreview` — so an HTML mockup is in the same frame with no script and no same origin,
 * an image the same <img> — in a gallery under the question, each with full screen. An option that IS a visual shows it
 * in its card, so picking the card picks the mockup.
 *
 * The posts are loaded by the window (question-main.tsx) and handed down by context: the form that draws the options is
 * the Deck's form too, and the Deck has no posts to hand it — there, a visual is named, not drawn.
 */

/** The shown question's posts, by id; `null` = none loaded here (the Deck's form). */
export const QuestionVisualsContext = createContext<ReadonlyMap<string, DisplayPost> | null>(null);

/** Full screen: the question window below its header (the drag strip stays the window's one app region, genie#1298). */
const FULL = 'fixed inset-x-0 bottom-0 top-11 z-50 flex flex-col bg-[var(--bg-1)]';

/** The gallery of one question: its own visuals, then its options' (each captioned with its option). */
export function QuestionVisuals({ posts, initialFull = null, captions }: { posts: readonly DisplayPost[]; initialFull?: string | null; captions?: ReadonlyMap<string, string> }) {
    const [full, setFull] = useState<string | null>(initialFull);
    // Esc restores, ahead of the window's own Esc (Later): taken in the capture phase and stopped there.
    useEffect(() => {
        if (full === null) return;
        const onKey = (e: KeyboardEvent): void => {
            if (e.key !== 'Escape' || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
            e.preventDefault();
            e.stopPropagation();
            setFull(null);
        };
        window.addEventListener('keydown', onKey, true);
        return () => window.removeEventListener('keydown', onKey, true);
    }, [full]);
    if (posts.length === 0) return null;
    const shown = full === null ? null : posts.find((p) => p.id === full) ?? null;
    return (
        <>
            <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,14rem),1fr))] gap-2">
                {posts.map((p) => (
                    <figure key={p.id} data-question-visual={p.id} className="m-0 flex min-w-0 flex-col overflow-hidden rounded-lg border border-[var(--border-1)] bg-[var(--bg-1)]">
                        <figcaption className="flex min-w-0 items-center gap-1 border-b border-[var(--border-1)] px-2 py-1 text-[12px]">
                            <span className="min-w-0 flex-1 truncate" title={p.title}>{p.title}</span>
                            {captions?.get(p.id) ? <span className="shrink-0 text-[11px] text-[var(--fg-3)]">{captions.get(p.id)}</span> : null}
                            <Button size="xs" variant="ghost" type="button" icon="maximize-2" data-action="question-visual-full" aria-label={`Show ${p.title} full screen`} title="Full screen" onClick={() => setFull(p.id)} />
                        </figcaption>
                        {/* A card's preview takes its height from this box (ArtifactPreview sizes by container units). */}
                        <div className="h-48 overflow-hidden [container-type:size]">
                            <ArtifactPreview post={p} />
                        </div>
                    </figure>
                ))}
            </div>
            {shown ? (
                <div data-question-visual-full={shown.id} role="dialog" aria-label={shown.title} className={FULL}>
                    <div className="flex shrink-0 items-center gap-2 border-b border-[var(--border-1)] px-3 py-2 text-[12px]">
                        <span className="min-w-0 flex-1 truncate font-semibold">{shown.title}</span>
                        <Button size="xs" variant="ghost" type="button" icon="minimize-2" data-action="question-visual-restore" aria-label="Restore" aria-keyshortcuts="Escape" title="Restore (Esc)" onClick={() => setFull(null)} />
                    </div>
                    <div className="relative min-h-0 flex-1 overflow-auto">
                        <ArtifactPreview post={shown} full />
                    </div>
                </div>
            ) : null}
        </>
    );
}

/** The gallery for question `index` of the form, from the window's posts; the Deck (no posts) names the visuals instead. */
export function QuestionGallery({ question, index }: { question: Question; index: number }) {
    const posts = useContext(QuestionVisualsContext);
    const refs = visualsOfQuestion(question);
    if (refs.length === 0) return null;
    const captions = new Map(question.options.flatMap((o) => (o.visual ? [[o.visual.postId, `Option ${o.label}`] as const] : [])));
    if (posts === null) {
        return (
            <p data-question-visual-titles={index} className="text-[12px] text-[var(--fg-3)]">
                Visuals: {refs.map((v) => v.title).join(', ')} (in the workspace’s ArtBoard)
            </p>
        );
    }
    const shown = refs.map((v) => posts.get(v.postId) ?? missing(v));
    return (
        <div data-question-visuals={index} className="flex flex-col gap-2">
            <QuestionVisuals posts={shown} captions={captions} />
        </div>
    );
}

/** An option's own visual, in its card: drawn small, never taking the click (the card is the choice). */
export function OptionVisual({ visual }: { visual: QuestionVisual }) {
    const posts = useContext(QuestionVisualsContext);
    if (posts === null) return null;
    const post = posts.get(visual.postId) ?? missing(visual);
    return (
        <span data-option-visual={visual.postId} className="pointer-events-none mt-1 block h-28 w-full overflow-hidden rounded-md border border-[var(--border-1)] [container-type:size]">
            <ArtifactPreview post={post} />
        </span>
    );
}

const missing = (v: QuestionVisual): DisplayPost => ({ id: v.postId, title: v.title, kind: v.kind, createdAt: '', askVerdict: false, contentError: `“${v.title}” could not be loaded.` });
