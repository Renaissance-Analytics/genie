import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { ContentRenderer, Icon } from '@particle-academy/react-fancy';
import { NO_REFS, parseChatMarkup, prepareChatMarkdown, type ChatRefs, type ChatSegment } from '../../core/chat-markup.js';
import { COPIED_MS, resultCopyPayload, tableTsv, writeCopy, type ClipboardItemCtor, type ClipboardLike, type CopyPayload } from '../../core/chat-copy.js';

/**
 * AN AGENT'S PROSE, WITH MOIC'S MARKUP (genie#1263) — used by the chat and by the Stream's message rows.
 *
 * The reply is prepared (`core/chat-markup.ts`: a half-written tail held back, forbidden UI removed, the model's own
 * internal links stripped, Genie's pills and file links added) and split into blocks. Prose goes through Fancy's
 * ContentRenderer, sanitised by default, exactly as the chat drew it before. The blocks react-fancy's renderer cannot
 * give a button to — a code block, a table, a `<result>` card — are drawn here, around a ContentRenderer for their
 * Markdown, so each button is a React element with its own handler (moic's lesson: a button inside rendered HTML needs
 * a delegated or inline handler; here it is never inside the HTML at all).
 *
 * A Genie link (`#file:` / `#agent:` / `#workspace:`) is an ordinary anchor: whoever draws this delegates the click
 * (ChatFlyout's log, StreamRow), and only a person's click navigates (genie#1265).
 */

export type CopyState = 'idle' | 'copied' | 'failed';

/** The copy control as markup, its state passed in: a copy icon that becomes a check, and a live region that says so. */
export function CopyButtonView({ kind, label, state, onCopy }: { kind: 'code' | 'table' | 'result'; label: string; state: CopyState; onCopy: () => void }) {
    return (
        <span className="inline-flex items-center">
            <button
                type="button"
                data-copy={kind}
                aria-label={label}
                title={label}
                onClick={(e) => { e.stopPropagation(); onCopy(); }}
                className="inline-flex size-6 items-center justify-center rounded-md text-[var(--fg-3)] hover:bg-[var(--bg-2)] hover:text-[var(--fg-1)]"
            >
                {state === 'copied'
                    ? <span data-icon-state="check" className="text-[var(--success)]"><Icon name="check" size="xs" /></span>
                    : <span data-icon-state="copy"><Icon name="copy" size="xs" /></span>}
            </button>
            {/* Announced, not only drawn (moic lacks this): a screen reader hears that the copy happened — or that it did not. */}
            <span role="status" aria-live="polite" className="sr-only">{state === 'copied' ? 'Copied' : state === 'failed' ? 'Copy failed' : ''}</span>
        </span>
    );
}

function CopyButton({ kind, label, payload }: { kind: 'code' | 'table' | 'result'; label: string; payload: () => CopyPayload }) {
    const [state, setState] = useState<CopyState>('idle');
    const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
    useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
    const onCopy = () => {
        const clipboard = (globalThis.navigator as Navigator | undefined)?.clipboard as unknown as ClipboardLike | undefined;
        const Item = (globalThis as unknown as { ClipboardItem?: ClipboardItemCtor }).ClipboardItem;
        void writeCopy(payload(), clipboard, Item).then((ok) => {
            setState(ok ? 'copied' : 'failed');
            if (timer.current) clearTimeout(timer.current);
            timer.current = setTimeout(() => setState('idle'), COPIED_MS);
        });
    };
    return <CopyButtonView kind={kind} label={label} state={state} onCopy={onCopy} />;
}

/** Agent and workspace links read as pills; a file link keeps the chat's link look (chat-file-links). */
const PILLS = "[&_a[href^='#agent:']]:rounded-full [&_a[href^='#agent:']]:bg-[var(--bg-2)] [&_a[href^='#agent:']]:px-1.5 [&_a[href^='#agent:']]:no-underline [&_a[href^='#agent:']]:text-[var(--violet-400)] [&_a[href^='#workspace:']]:rounded-full [&_a[href^='#workspace:']]:bg-[var(--bg-2)] [&_a[href^='#workspace:']]:px-1.5 [&_a[href^='#workspace:']]:no-underline [&_a[href^='#workspace:']]:text-[var(--fg-1)]";

function Prose({ text, className }: { text: string; className: string }) {
    return <ContentRenderer value={text} format="markdown" lineSpacing={1.5} className={`${className} ${PILLS}`} />;
}

function Segments({ segments, className }: { segments: readonly ChatSegment[]; className: string }) {
    return (
        <>
            {segments.map((s, i) => {
                switch (s.kind) {
                    case 'markdown':
                        return <Prose key={i} text={s.text} className={className} />;
                    case 'code':
                        return (
                            <div key={i} data-chat-code={s.lang} className="overflow-hidden rounded-lg border border-[var(--border-1)] bg-[var(--bg-1)]">
                                <div className="flex items-center justify-between border-b border-[var(--border-1)] pl-2.5 pr-1 font-mono text-[11px] text-[var(--fg-4)]">
                                    <span>{s.lang}</span>
                                    <CopyButton kind="code" label="Copy code" payload={() => ({ plain: s.code })} />
                                </div>
                                <pre className="overflow-x-auto px-2.5 py-2 font-mono text-[12px] leading-[1.5] text-[var(--fg-1)]"><code>{s.code}</code></pre>
                            </div>
                        );
                    case 'table':
                        return (
                            <div key={i} data-chat-table="" className="flex flex-col">
                                <div className="flex justify-end"><CopyButton kind="table" label="Copy table" payload={() => ({ plain: tableTsv(s.rows) })} /></div>
                                <div className="overflow-x-auto"><Prose text={s.markdown} className={`${className} [&_table]:w-full [&_td]:border-b [&_td]:border-[var(--border-1)] [&_td]:px-2 [&_td]:py-1 [&_th]:border-b [&_th]:border-[var(--border-2)] [&_th]:px-2 [&_th]:py-1 [&_th]:text-left`} /></div>
                            </div>
                        );
                    case 'result':
                        return (
                            <section key={i} data-chat-result="" className="overflow-hidden rounded-lg border border-[var(--border-2)] bg-[var(--bg-1)]">
                                <header className="flex items-center gap-1.5 border-b border-[var(--border-1)] pl-2.5 pr-1 font-mono text-[11px] text-[var(--violet-400)]">
                                    <Icon name="clipboard-list" size="xs" />
                                    <span>Result</span>
                                    <span className="ml-auto"><CopyButton kind="result" label="Copy result" payload={() => resultCopyPayload(s.body)} /></span>
                                </header>
                                <div className="flex flex-col gap-2 px-2.5 py-2"><Segments segments={s.children} className={className} /></div>
                            </section>
                        );
                    case 'highlight':
                        return (
                            <div key={i} data-chat-highlight="" role="note" className="flex items-start gap-2 rounded-r-lg border-l-2 border-[var(--warning)] bg-[var(--bg-1)] px-2.5 py-1.5">
                                <span className="mt-0.5 text-[var(--warning)]"><Icon name="lightbulb" size="xs" /></span>
                                <div className="flex min-w-0 flex-1 flex-col gap-2"><Segments segments={s.children} className={className} /></div>
                            </div>
                        );
                    case 'followup':
                        return (
                            <div key={i} data-chat-followup="" className="flex items-start gap-2 rounded-lg border border-dashed border-[var(--border-2)] px-2.5 py-1.5">
                                <span className="mt-0.5 text-[var(--violet-400)]"><Icon name="message-circle-question" size="xs" /></span>
                                <div className="flex min-w-0 flex-1 flex-col gap-2"><Segments segments={s.children} className={className} /></div>
                            </div>
                        );
                }
            })}
        </>
    );
}

export interface ChatProseProps {
    text: string;
    /** What pills may open; absent = none (every pill is its words, every destination disappears). */
    refs?: ChatRefs | undefined;
    className?: string | undefined;
}

/** Memoised on its text and refs: a busy agent's push re-renders only the reply that grew (ChatFlyout's ChatReply). */
export const ChatProse = memo(function ChatProse({ text, refs = NO_REFS, className = '' }: ChatProseProps) {
    const segments = useMemo(() => parseChatMarkup(prepareChatMarkdown(text, refs)), [text, refs]);
    return (
        <div data-chat-prose="" className="flex min-w-0 flex-col gap-2">
            <Segments segments={segments} className={className} />
        </div>
    );
});
