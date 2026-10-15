import { initTheme } from '@particle-academy/react-fancy';
import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { DeckItem } from '../core/deck.js';
import { QuestionApp } from './components/QuestionApp.js';
import { registerAppIcons } from './icons.js';
import './styles.css';

/**
 * The ForceTheQuestion window's renderer: QuestionApp over the question preload's `genieQuestion`. Pushed, never polled:
 * main sends the question to show; the window asks once on load in case it opened before the first push arrived.
 */
type View = { item: DeckItem; waiting: number };
interface QuestionBridge {
    current(): Promise<View | null>;
    answer(selections: string[][], notes: string[]): Promise<{ ok: true } | { ok: false; reason: string }>;
    later(): Promise<void>;
    dismiss(notes: string[]): Promise<{ ok: true } | { ok: false; reason: string }>;
    onShow(listener: (view: View) => void): () => void;
}
declare global {
    interface Window { genieQuestion?: QuestionBridge }
}

function Question({ bridge }: { bridge: QuestionBridge }) {
    const [view, setView] = useState<View | null>(null);
    const [sending, setSending] = useState(false);
    const [refusal, setRefusal] = useState<string | null>(null);
    useEffect(() => {
        void bridge.current().then((v) => { if (v) setView(v); });
        return bridge.onShow((v) => { setView(v); setRefusal(null); });
    }, [bridge]);
    return (
        <QuestionApp
            view={view}
            sending={sending}
            refusal={refusal}
            onAnswer={(selections, notes) => {
                setSending(true);
                setRefusal(null);
                // A refusal, and a bridge that failed outright, are both said beside the Answer button — never swallowed.
                void bridge.answer(selections, notes)
                    .then((r) => { if (!r.ok) setRefusal(r.reason); })
                    .catch((error: unknown) => { setRefusal(error instanceof Error ? error.message : String(error)); })
                    .finally(() => setSending(false));
            }}
            onLater={() => { void bridge.later(); }}
            onDismiss={(notes) => {
                setSending(true);
                setRefusal(null);
                // Said beside the buttons like a refused answer — a Dismiss that did nothing must not look like one that worked.
                // The notes the person wrote in the form go with it — the agent reads why, or what to do instead.
                void bridge.dismiss(notes)
                    .then((r) => { if (!r.ok) setRefusal(r.reason); })
                    .catch((error: unknown) => { setRefusal(error instanceof Error ? error.message : String(error)); })
                    .finally(() => setSending(false));
            }}
        />
    );
}

registerAppIcons();
initTheme();
const host = document.getElementById('root');
if (!host) throw new Error('#root is missing from question.html');
const bridge = window.genieQuestion;
createRoot(host).render(bridge ? <Question bridge={bridge} /> : <p style={{ padding: 16 }}>The question window’s bridge is missing.</p>);
