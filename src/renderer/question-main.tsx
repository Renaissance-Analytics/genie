import { initTheme } from '@particle-academy/react-fancy';
import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { extractFileRefs, type AskFileRef } from '../core/ask-file-refs.js';
import type { DeckItem } from '../core/deck.js';
import { activeQuestion, dropDraft, mergeDrafts, putDraft, type QuestionDraft, type QuestionDrafts } from '../core/question-drafts.js';
import { QuestionApp } from './components/QuestionApp.js';
import { registerAppIcons } from './icons.js';
import './styles.css';

/**
 * The ForceTheQuestion window's renderer: QuestionApp over the question preload's `genieQuestion`. Pushed, never polled:
 * main sends the queue to show; the window asks once on load in case it opened before the first push arrived.
 *
 * A push is frequent — every question asked or answered anywhere, by any agent — and it must never cost the person what
 * they are typing (the owner, 2026-10-15). So the drafts live HERE, keyed by question id (core/question-drafts.ts), not in
 * the form: a push merges into them (the window's own copy wins), the question the person picked stays picked while it
 * is asked, and every change is also handed to main, which keeps it if this window closes.
 */
type View = { item: DeckItem; waiting: number; queue?: readonly DeckItem[]; parked?: readonly string[]; drafts?: QuestionDrafts };
type Outcome = { ok: true } | { ok: false; reason: string };
interface QuestionBridge {
    current(): Promise<View | null>;
    answer(selections: string[][], notes: string[], id?: string): Promise<Outcome>;
    later(): Promise<void>;
    dismiss(notes: string[], id?: string): Promise<Outcome>;
    select?(id: string): Promise<void>;
    draft?(id: string, draft: QuestionDraft): Promise<void>;
    onShow(listener: (view: View) => void): () => void;
    /** Genie 1's file drawer: which named files are in the question's workspace (`null` = unknown), one file, and the window widening. */
    files?(id: string, paths: string[]): Promise<string[] | null>;
    file?(id: string, path: string): Promise<{ ok: true; path: string; text: string } | { ok: false; reason: string }>;
    drawer?(open: boolean): Promise<void>;
}
type Drawer = { path: string; text?: string; line?: number | null; error?: string };

/** The paths the question names, in its own words (core/ask-file-refs.ts). */
const namedPaths = (item: DeckItem): string[] =>
    extractFileRefs((item.answer.kind === 'form' ? item.answer.questions ?? [] : []).map((q) => q.question).join('\n\n')).map((ref) => ref.path);
declare global {
    interface Window { genieQuestion?: QuestionBridge }
}

const idsOf = (v: View): string[] => (v.queue && v.queue.length > 0 ? v.queue : [v.item]).map((q) => q.id);

function Question({ bridge }: { bridge: QuestionBridge }) {
    const [view, setView] = useState<View | null>(null);
    const [sending, setSending] = useState(false);
    // A refusal belongs to the question it was given for: said with that question, gone when that question is.
    const [refusal, setRefusal] = useState<{ id: string; reason: string } | null>(null);
    const [picked, setPicked] = useState<string | null>(null);
    const [drafts, setDrafts] = useState<QuestionDrafts>({});
    const [existing, setExisting] = useState<{ id: string; set: ReadonlySet<string> | null } | null>(null);
    const [drawer, setDrawer] = useState<(Drawer & { id: string }) | null>(null);
    useEffect(() => {
        const receive = (v: View) => {
            setView(v);
            // The window's drafts win; main's fill only questions this window has none for; a question gone drops its draft.
            setDrafts((local) => mergeDrafts(local, v.drafts ?? {}, idsOf(v)));
        };
        void bridge.current().then((v) => { if (v) receive(v); });
        return bridge.onShow((v) => {
            setRefusal((r) => (r !== null && idsOf(v).includes(r.id) ? r : null));
            receive(v);
        });
    }, [bridge]);
    const settle = (call: Promise<Outcome>, id: string) => {
        setSending(true);
        setRefusal(null);
        // A refusal, and a bridge that failed outright, are both said beside the Answer button — never swallowed.
        void call
            .then((r) => {
                if (!r.ok) { setRefusal({ id, reason: r.reason }); return; }
                setDrafts((local) => dropDraft(local, id));
                setPicked((p) => (p === id ? null : p));
            })
            .catch((error: unknown) => { setRefusal({ id, reason: error instanceof Error ? error.message : String(error) }); })
            .finally(() => setSending(false));
    };
    const shown = view ? activeQuestion({ picked, shown: view.item.id, queue: idsOf(view) }) : null;
    const shownItem = view ? (view.queue ?? []).find((q) => q.id === shown) ?? view.item : null;
    const named = shownItem ? namedPaths(shownItem).join('\n') : '';
    // Which named files are there — asked when the shown question changes. A failed check offers every one (fails open, as Genie 1).
    useEffect(() => {
        if (!shown || named === '' || !bridge.files) return;
        let live = true;
        bridge.files(shown, named.split('\n'))
            .then((got) => { if (live) setExisting({ id: shown, set: got ? new Set(got) : null }); })
            .catch(() => { if (live) setExisting({ id: shown, set: null }); });
        return () => { live = false; };
    }, [bridge, shown, named]);
    // The drawer belongs to the question it was opened from: another question shown closes it, and the window narrows back.
    const open = drawer !== null && drawer.id === shown ? drawer : null;
    useEffect(() => {
        if (drawer !== null && drawer.id !== shown) {
            setDrawer(null);
            void bridge.drawer?.(false);
        }
    }, [bridge, drawer, shown]);
    const openFile = (ref: AskFileRef) => {
        if (!shown || !bridge.file) return;
        const id = shown;
        setDrawer({ id, path: ref.path, line: ref.line ?? null });
        void bridge.drawer?.(true);
        bridge.file(id, ref.path)
            .then((r) => setDrawer((d) => (d && d.id === id && d.path === ref.path ? (r.ok ? { ...d, text: r.text } : { ...d, error: r.reason }) : d)))
            .catch((error: unknown) => setDrawer((d) => (d && d.id === id && d.path === ref.path ? { ...d, error: error instanceof Error ? error.message : String(error) } : d)));
    };
    const closeFile = () => {
        setDrawer(null);
        void bridge.drawer?.(false);
    };
    return (
        <QuestionApp
            view={view}
            sending={sending}
            refusal={refusal !== null && refusal.id === shown ? refusal.reason : null}
            picked={picked}
            drafts={drafts}
            existing={existing !== null && existing.id === shown ? existing.set : null}
            drawer={open}
            {...(bridge.file ? { onOpenFile: openFile, onCloseFile: closeFile } : {})}
            onPick={(id) => {
                setPicked(id);
                void bridge.select?.(id);
            }}
            onDraft={(id, draft) => {
                setDrafts((local) => putDraft(local, id, draft));
                void bridge.draft?.(id, draft);
            }}
            onAnswer={(selections, notes, id) => settle(bridge.answer(selections, notes, id), id)}
            onLater={() => { setPicked(null); void bridge.later(); }}
            // Said beside the buttons like a refused answer — a Dismiss that did nothing must not look like one that worked.
            // The notes the person wrote in the form go with it — the agent reads why, or what to do instead.
            onDismiss={(notes, id) => settle(bridge.dismiss(notes, id), id)}
        />
    );
}

registerAppIcons();
initTheme();
const host = document.getElementById('root');
if (!host) throw new Error('#root is missing from question.html');
const bridge = window.genieQuestion;
createRoot(host).render(bridge ? <Question bridge={bridge} /> : <p style={{ padding: 16 }}>The question window’s bridge is missing.</p>);
