import type { DeckItem } from '../core/deck.js';
import { deckItemRef } from '../core/deck-answer-wire.js';
import type { DisplayPost } from '../core/artboard.js';
import type { QuestionDraft, QuestionDrafts } from '../core/question-drafts.js';
import type { QuestionMedia } from '../core/question-media.js';
import { isRemoteQuestionId } from '../core/remote-question-id.js';
import type { GenieBridge } from './bridge.js';
import type { FeatureAction } from './features.js';

/**
 * THE FORCETHEQUESTION PAGE'S BRIDGE (client/host split step 2f-1, Tynn #912). A client is a dumb terminal: the question
 * window keeps only its window, through its preload (what to show, Later, the queue pick, the draft, Open in Files, the
 * drawer's width), and reaches genie-host over the one protocol for the rest, on its own frame port like every Genie window:
 *  - an answer and a Dismiss are `features.act`, the Deck's own actions (an answer names its item by id and revision, Tynn
 *    #861; a Dismiss carries the item, as the Deck's does);
 *  - a question's named files and its visuals are `questions.files` / `questions.file` / `questions.visuals`.
 * ANOTHER machine's question (Tynn #726; its id is RemoteQuestions') goes through the preload's `remote`, back to the window
 * that drives that machine and holds THAT host's connection. It never reaches this host.
 *
 * The local door keeps ONE protocol connection per window (a second replaces the first), so the calls share one, opened
 * when one is needed and closed once nothing has used it for `idleMs`: a local connection hears every estate push, and
 * the question window needs none of them.
 */
export type QuestionView = { item: DeckItem; waiting: number; queue?: readonly DeckItem[]; parked?: readonly string[]; drafts?: QuestionDrafts };
type Outcome = { ok: true } | { ok: false; reason: string };
type FileAnswer = { ok: true; path: string; text: string } | { ok: true; path: string; media: QuestionMedia } | { ok: false; reason: string };
type VisualsAnswer = { ok: true; posts: DisplayPost[] } | { ok: false; reason: string };

/** What the question preload exposes (main/question-preload.ts): the window's own calls, and another machine's question. */
export interface QuestionPreload {
    current(): Promise<QuestionView | null>;
    later(): Promise<void>;
    select?(id: string): Promise<void>;
    draft?(id: string, draft: QuestionDraft): Promise<void>;
    onShow(listener: (view: QuestionView) => void): () => void;
    openInFiles?(id: string, path: string): Promise<boolean>;
    drawer?(open: boolean): Promise<void>;
    /** The whole window maximized to its display's work area, or restored (Tynn #1019). */
    maximize?(on: boolean): Promise<void>;
    remote(request: { kind: 'answer'; id: string; selections: string[][]; notes: string[] } | { kind: 'dismiss'; id: string; notes: string[] } | { kind: 'visuals'; id: string }): Promise<unknown>;
}

/** What the page calls (components/QuestionApp via question-main.tsx). */
export interface QuestionBridge {
    current(): Promise<QuestionView | null>;
    answer(selections: string[][], notes: string[], id?: string): Promise<Outcome>;
    later(): Promise<void>;
    dismiss(notes: string[], id?: string): Promise<Outcome>;
    select?(id: string): Promise<void>;
    draft?(id: string, draft: QuestionDraft): Promise<void>;
    onShow(listener: (view: QuestionView) => void): () => void;
    /** Genie 1's file drawer: which named files are in the question's workspace (`null` = unknown), one file, and the window widening. */
    files?(id: string, paths: string[]): Promise<string[] | null>;
    file?(id: string, path: string): Promise<FileAnswer>;
    openInFiles?(id: string, path: string): Promise<boolean>;
    drawer?(open: boolean): Promise<void>;
    maximize?(on: boolean): Promise<void>;
    /** The shown question's visuals (Tynn #835): its ArtBoard posts, from its workspace or the machine that asked. */
    visuals?(id: string): Promise<VisualsAnswer>;
}

/** The page's protocol client: connectRemote over the window's own frame port, as far as the question window uses it. */
export interface QuestionProtocol {
    readonly ready: Promise<{ ok: true } | { ok: false; reason: string }>;
    readonly bridge: Pick<GenieBridge, 'features' | 'questions'>;
    close(): void;
}

const IDLE_MS = 30_000;
const ANSWERED = 'that question was already answered';
const NO_READS = 'this Genie cannot read a question’s files';
const REMOTE_FILES = 'this question is another machine’s; open its files in the window connected to it';

const reasonOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const outcomeOf = (value: unknown): Outcome => {
    const v = value as { ok?: unknown; reason?: unknown } | null;
    return v && v.ok === true ? { ok: true } : { ok: false, reason: v && typeof v.reason === 'string' ? v.reason : 'the window connected to that machine did not answer' };
};

export function questionBridge(preload: QuestionPreload, connect: () => QuestionProtocol, options: { idleMs?: number } = {}): QuestionBridge {
    const idleMs = options.idleMs ?? IDLE_MS;
    let view: QuestionView | null = null;
    const seen = (v: QuestionView | null): QuestionView | null => { if (v) view = v; return v; };
    /** A question this window was shown, by id (an answer without one is for the question shown). */
    const itemOf = (id: string | undefined): DeckItem | null => {
        if (!view) return null;
        const target = id ?? view.item.id;
        return [view.item, ...(view.queue ?? [])].find((q) => q.id === target) ?? null;
    };

    let client: QuestionProtocol | null = null;
    let inFlight = 0;
    let idle: ReturnType<typeof setTimeout> | null = null;
    const drop = (which: QuestionProtocol) => {
        if (client !== which) return;
        client = null;
        which.close();
    };
    /** Run `call` on the one shared connection; a link that did not come up, or failed under a call, is opened anew next time. */
    const withProtocol = async <T>(call: (bridge: QuestionProtocol['bridge']) => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; reason: string }> => {
        if (idle) { clearTimeout(idle); idle = null; }
        const mine = client ?? (client = connect());
        inFlight += 1;
        try {
            const ready = await mine.ready;
            if (!ready.ok) { drop(mine); return { ok: false, reason: ready.reason }; }
            return { ok: true, value: await call(mine.bridge) };
        } catch (error) {
            drop(mine);
            return { ok: false, reason: reasonOf(error) };
        } finally {
            inFlight -= 1;
            if (inFlight === 0 && client !== null) {
                const open = client;
                idle = setTimeout(() => { idle = null; if (inFlight === 0) drop(open); }, idleMs);
            }
        }
    };
    const act = async (action: FeatureAction): Promise<Outcome> => {
        const done = await withProtocol((bridge) => bridge.features.act(action));
        return done.ok ? { ok: true } : done;
    };

    return {
        current: async () => seen(await preload.current()),
        onShow: (listener) => preload.onShow((v) => { seen(v); listener(v); }),
        later: () => preload.later(),
        ...(preload.select ? { select: (id: string) => preload.select!(id) } : {}),
        ...(preload.draft ? { draft: (id: string, draft: QuestionDraft) => preload.draft!(id, draft) } : {}),
        ...(preload.openInFiles ? { openInFiles: (id: string, path: string) => preload.openInFiles!(id, path) } : {}),
        ...(preload.drawer ? { drawer: (open: boolean) => preload.drawer!(open) } : {}),
        ...(preload.maximize ? { maximize: (on: boolean) => preload.maximize!(on) } : {}),
        answer: async (selections, notes, id) => {
            const target = id ?? view?.item.id;
            if (target !== undefined && isRemoteQuestionId(target)) return outcomeOf(await preload.remote({ kind: 'answer', id: target, selections, notes }).catch((e: unknown) => ({ ok: false, reason: reasonOf(e) })));
            const item = itemOf(target);
            if (!item) return { ok: false, reason: ANSWERED };
            // The Deck's own answer (Tynn #861): the item by id and revision, the picks, one note per question, no overall note.
            return act({ kind: 'deck.answerForm', item: deckItemRef(item), selections, notes, note: '' } as unknown as FeatureAction);
        },
        dismiss: async (notes, id) => {
            const target = id ?? view?.item.id;
            if (target !== undefined && isRemoteQuestionId(target)) return outcomeOf(await preload.remote({ kind: 'dismiss', id: target, notes }).catch((e: unknown) => ({ ok: false, reason: reasonOf(e) })));
            const item = itemOf(target);
            if (!item) return { ok: false, reason: ANSWERED };
            // The Deck's own Dismiss: it carries the item, which the host checks is an agent's question (feature-deck.ts).
            return act({ kind: 'deck.dismiss', item, notes });
        },
        files: async (id, paths) => {
            if (isRemoteQuestionId(id)) return null;
            const done = await withProtocol((bridge) => (bridge.questions ? bridge.questions.files(id, paths) : Promise.resolve(null)));
            return done.ok ? done.value : null;
        },
        file: async (id, path) => {
            if (isRemoteQuestionId(id)) return { ok: false, reason: REMOTE_FILES };
            const done = await withProtocol((bridge) => (bridge.questions ? bridge.questions.file(id, path) : Promise.resolve<FileAnswer>({ ok: false, reason: NO_READS })));
            return done.ok ? done.value : done;
        },
        visuals: async (id) => {
            if (isRemoteQuestionId(id)) {
                const r = await preload.remote({ kind: 'visuals', id }).catch((e: unknown) => ({ ok: false, reason: reasonOf(e) })) as { ok?: unknown; posts?: unknown; reason?: unknown } | null;
                return r && r.ok === true && Array.isArray(r.posts) ? { ok: true, posts: r.posts as DisplayPost[] } : { ok: false, reason: r && typeof r.reason === 'string' ? r.reason : 'the window connected to that machine did not answer' };
            }
            const done = await withProtocol((bridge) => (bridge.questions ? bridge.questions.visuals(id) : Promise.resolve<VisualsAnswer>({ ok: false, reason: NO_READS })));
            return done.ok ? done.value : done;
        },
    };
}

declare global {
    interface Window { genieQuestion?: QuestionPreload }
}
