import { memo, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type FocusEvent as ReactFocusEvent, type ReactNode } from 'react';
import { Button, ContentRenderer, Icon, type RenderExtension, type RenderExtensionProps } from '@particle-academy/react-fancy';
import { NO_REFS, liftChatBlocks, prepareChatMarkdown, type ChatRefs } from '../../core/chat-markup.js';
import { COPIED_MS, inlineCopyText, resultCopyPayload } from '../../core/chat-copy.js';
import { personText } from '../../core/person-text.js';
import { copyToClipboard, genieClipboardWriter } from '../clipboard.js';

/**
 * AN AGENT'S PROSE, WITH MOIC'S MARKUP (genie#1263) — used by the chat and by the Stream's message rows.
 *
 * The reply is prepared (`core/chat-markup.ts`: while it arrives, a half-written pill or non-block tag held back; forbidden
 * UI removed, the model's own internal links stripped, Genie's pills and file links added, each block put where
 * react-fancy lifts it) and drawn by ONE react-fancy ContentRenderer (5.68.0), sanitised by default. A reply still
 * arriving is drawn with `streaming="progressive"`: react-fancy holds a partial block tag or fence marker, and draws an
 * open block as its card and an open fence as code (no copy button until it closes), filling in.
 *
 * - code blocks and tables get react-fancy's own copy buttons (on by default), written through Genie's clipboard writer
 *   — main's clipboard, checked (`renderer/clipboard.ts`); Genie draws none of its own, so there is one per block;
 * - `<result>`, `<highlight>` and `<followup>` are `markdown: true` extensions: fancy renders their body (sanitised, with
 *   its copy buttons) and Genie draws the card around it. Only a `<result>` has a button of Genie's: "Copy result",
 *   rich, which fancy has no notion of.
 *
 * - inline code and web links get ONE hover copy button of Genie's, over the reply (genie#1556, `InlineCopyButton`):
 *   fancy draws no button on them.
 *
 * A Genie link (`#file:` / `#agent:` / `#workspace:`) is an ordinary anchor: whoever draws this delegates the click
 * (ChatFlyout's log, StreamRow), and only a person's click on a LINK navigates (genie#1265). A click on a copy button is a
 * copy and nothing else: it stops here (`stopCopyClick`).
 */

export type CopyState = 'idle' | 'copied' | 'failed';

/** The "Copy result" control as markup, its state passed in: copy, then a check or an x, and a live region that says so. */
export function CopyButtonView({ kind, label, state, onCopy }: { kind: 'result' | 'inline' | 'link'; label: string; state: CopyState; onCopy: () => void }) {
    return (
        <span className="inline-flex items-center">
            <Button size="xs" labelClassName="contents"
                type="button"
                data-copy={kind}
                data-copy-state={state}
                aria-label={label}
                title={label}
                onClick={onCopy}
                className="inline-flex size-6 items-center justify-center rounded-md text-[var(--fg-3)] hover:bg-[var(--bg-2)] hover:text-[var(--fg-1)]"
            >
                {state === 'copied'
                    ? <span data-icon-state="check" className="text-[var(--success)]"><Icon name="check" size="xs" /></span>
                    : state === 'failed'
                        ? <span data-icon-state="x" className="text-[var(--danger)]"><Icon name="x" size="xs" /></span>
                        : <span data-icon-state="copy"><Icon name="copy" size="xs" /></span>}
            </Button>
            {/* Announced, not only drawn (moic lacks this): a screen reader hears that the copy happened — or that it did not. */}
            <span role="status" aria-live="polite" className="sr-only">{state === 'copied' ? 'Copied' : state === 'failed' ? 'Copy failed' : ''}</span>
        </span>
    );
}

/** A copy and its check or x for COPIED_MS: one state per button. */
function useCopy(): [CopyState, (payload: Parameters<typeof copyToClipboard>[0]) => void] {
    const [state, setState] = useState<CopyState>('idle');
    const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
    useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
    const copy = (payload: Parameters<typeof copyToClipboard>[0]) => {
        void copyToClipboard(payload).then((ok) => {
            setState(ok ? 'copied' : 'failed');
            if (timer.current) clearTimeout(timer.current);
            timer.current = setTimeout(() => setState('idle'), COPIED_MS);
        });
    };
    return [state, copy];
}

function CopyResultButton({ body }: { body: string }) {
    const [state, copy] = useCopy();
    return <CopyButtonView kind="result" label="Copy result" state={state} onCopy={() => copy(resultCopyPayload(body))} />;
}

/** How long the inline copy button stays after the pointer leaves its code or link: long enough to reach it. */
const HIDE_MS = 300;

/** What the pointer (or focus) is on: the text to copy, and where its right edge is inside the reply. */
interface InlineHover { kind: 'inline' | 'link'; text: string; top: number; left: number }

/**
 * THE INLINE COPY BUTTON (genie#1556): one react-fancy Button per reply, laid over it at the hovered code span's or link's
 * end — absolute, so the line never moves and the text stays selectable. Keyed by what it copies, so a new target starts
 * with the copy icon.
 */
function InlineCopyButton({ hover }: { hover: InlineHover }) {
    const [state, copy] = useCopy();
    return (
        <span data-inline-copy="" className="absolute z-10 rounded-md bg-[var(--bg-1)] shadow-sm" style={{ top: hover.top, left: hover.left }}>
            <CopyButtonView kind={hover.kind} label={hover.kind === 'link' ? 'Copy link' : 'Copy'} state={state} onCopy={() => copy({ plain: hover.text })} />
        </span>
    );
}

/** The inline code span or web link at `target` in this reply, read for `inlineCopyText`; `null` = no button. */
function inlineHoverAt(target: EventTarget | null, container: HTMLElement): InlineHover | null {
    const el = target as Element | null;
    if (!el || typeof el.closest !== 'function') return null;
    const hit = el.closest('code, a');
    if (!hit || !container.contains(hit)) return null;
    const copied = inlineCopyText({ tag: hit.tagName, text: hit.textContent ?? '', href: hit.getAttribute('href'), inBlock: hit.closest('pre') !== null });
    if (!copied) return null;
    const box = container.getBoundingClientRect();
    const at = hit.getBoundingClientRect();
    return { ...copied, top: at.top - box.top + at.height / 2 - 12, left: at.right - box.left + 2 };
}

/** A click on a copy button — react-fancy's or Genie's — is a copy: it never reaches the row or the log behind it. */
export function stopCopyClick(e: { target: unknown; stopPropagation(): void }): void {
    const target = e.target as { closest?: (selector: string) => unknown } | null;
    if (target?.closest?.('[data-react-fancy-content-copy], [data-copy]')) e.stopPropagation();
}

function ResultCard({ content, children }: RenderExtensionProps) {
    return (
        <section data-chat-result="" className="my-2 overflow-hidden rounded-lg border border-[var(--border-2)] bg-[var(--bg-1)]">
            <header className="flex items-center gap-1.5 border-b border-[var(--border-1)] pl-2.5 pr-1 font-mono text-[11px] text-[var(--violet-400)]">
                <Icon name="clipboard-list" size="xs" />
                <span>Result</span>
                {/* `content` is the body as Markdown (Genie's links in it): copied RICH, never as its source (core/chat-copy.ts). */}
                <span className="ml-auto"><CopyResultButton body={content} /></span>
            </header>
            <div className="px-2.5 py-2">{children}</div>
        </section>
    );
}

function Callout({ data, icon, tone, children }: { data: 'highlight' | 'followup'; icon: string; tone: string; children: ReactNode }) {
    const frame = data === 'highlight'
        ? 'rounded-r-lg border-l-2 border-[var(--warning)] bg-[var(--bg-1)]'
        : 'rounded-lg border border-dashed border-[var(--border-2)]';
    return (
        <div {...{ [`data-chat-${data}`]: '' }} {...(data === 'highlight' ? { role: 'note' } : {})} className={`my-2 flex items-start gap-2 px-2.5 py-1.5 ${frame}`}>
            <span className={`mt-0.5 ${tone}`}><Icon name={icon} size="xs" /></span>
            <div className="min-w-0 flex-1">{children}</div>
        </div>
    );
}

/** Genie's blocks, drawn by react-fancy around their rendered Markdown body. One array: the renderer memoises on it. */
const CHAT_BLOCKS: RenderExtension[] = [
    { tag: 'result', markdown: true, component: ResultCard },
    { tag: 'highlight', markdown: true, component: ({ children }) => <Callout data="highlight" icon="lightbulb" tone="text-[var(--warning)]">{children}</Callout> },
    { tag: 'followup', markdown: true, component: ({ children }) => <Callout data="followup" icon="message-circle-question" tone="text-[var(--violet-400)]">{children}</Callout> },
];

/** Agent and workspace links read as pills; a file link keeps the chat's link look (chat-file-links). */
const PILLS = "[&_a[href^='#agent:']]:rounded-full [&_a[href^='#agent:']]:bg-[var(--bg-2)] [&_a[href^='#agent:']]:px-1.5 [&_a[href^='#agent:']]:no-underline [&_a[href^='#agent:']]:text-[var(--violet-400)] [&_a[href^='#workspace:']]:rounded-full [&_a[href^='#workspace:']]:bg-[var(--bg-2)] [&_a[href^='#workspace:']]:px-1.5 [&_a[href^='#workspace:']]:no-underline [&_a[href^='#workspace:']]:text-[var(--fg-1)]";
const TABLES = '[&_table]:w-full [&_td]:border-b [&_td]:border-[var(--border-1)] [&_td]:px-2 [&_td]:py-1 [&_th]:border-b [&_th]:border-[var(--border-2)] [&_th]:px-2 [&_th]:py-1 [&_th]:text-left';

export interface ChatProseProps {
    text: string;
    /** What pills may open; absent = none (every pill is its words, every destination disappears). */
    refs?: ChatRefs | undefined;
    /**
     * The reply is still arriving (`core/chat-view.ts` arrivingMessageId): react-fancy draws it progressively. Absent or
     * `false` = finished, drawn whole — react-fancy's contract is `streaming={done ? false : "progressive"}`.
     */
    streaming?: boolean | undefined;
    className?: string | undefined;
}

/** Memoised on its text and refs: a busy agent's push re-renders only the reply that grew (ChatFlyout's ChatReply). */
export const ChatProse = memo(function ChatProse({ text, refs = NO_REFS, streaming = false, className = '' }: ChatProseProps) {
    // No internal id is drawn (Tynn #696): AFTER Genie's links are made, so a pill's id still reaches its target.
    const value = useMemo(() => liftChatBlocks(personText(prepareChatMarkdown(text, refs, streaming)), streaming), [text, refs, streaming]);
    const [hover, setHover] = useState<InlineHover | null>(null);
    const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const keep = () => { if (hideTimer.current) { clearTimeout(hideTimer.current); hideTimer.current = null; } };
    useEffect(() => keep, []);
    const hide = () => { keep(); setHover(null); };
    const onOver = (e: ReactMouseEvent<HTMLDivElement> | ReactFocusEvent<HTMLDivElement>) => {
        // Over the button itself the hover holds: the pointer went there to press it.
        if ((e.target as Element | null)?.closest?.('[data-inline-copy]')) { keep(); return; }
        const next = inlineHoverAt(e.target, e.currentTarget);
        if (next === null) {
            // Off the code or link: gone after a moment, so the pointer can cross the gap to the button.
            if (hover !== null && hideTimer.current === null) hideTimer.current = setTimeout(hide, HIDE_MS);
            return;
        }
        keep();
        setHover((was) => (was && was.text === next.text && was.top === next.top && was.left === next.left ? was : next));
    };
    return (
        <div data-chat-prose="" className="relative flex min-w-0 flex-col" onClick={stopCopyClick} onMouseOver={onOver} onFocus={onOver} onMouseLeave={hide}>
            <ContentRenderer value={value} format="markdown" lineSpacing={1.5} extensions={CHAT_BLOCKS} streaming={streaming ? 'progressive' : false} clipboardWriter={genieClipboardWriter} className={`${className} ${PILLS} ${TABLES}`} />
            {hover ? <InlineCopyButton key={`${hover.kind}:${hover.text}`} hover={hover} /> : null}
        </div>
    );
});
