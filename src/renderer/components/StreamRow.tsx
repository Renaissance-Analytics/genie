import { Icon } from '@particle-academy/react-fancy';
import { countRender } from '../render-count.js';
import { memo } from 'react';
import type { LedgerRow, Tone } from '../../core/stream-view.js';
import { chatLinkTarget, type ChatLinkTarget, type ChatRefs } from '../../core/chat-markup.js';
import { ChatProse } from './ChatProse.js';

/**
 * ONE LEDGER ROW — time, icon, main, meta.
 *
 * Every decision about what this row says is already made in `stream-view.ts` and tested
 * without a DOM. This turns a `LedgerRow` into markup and makes no judgements of its own.
 */

const TONE: Record<Tone, string> = {
    default: 'text-[var(--fg-1)]',
    muted: 'text-[var(--fg-3)]',
    violet: 'text-[var(--violet-400)]',
    emerald: 'text-[var(--success)]',
    sky: 'text-[var(--sky-400)]',
    amber: 'text-[var(--warning)]',
    bad: 'text-[var(--danger)]',
};

/** The speaker's colour (the board): you blue, the agent violet, a peer violet too — it is an agent. */
const WHO_TONE = { you: 'text-[var(--primary)]', agent: 'text-[var(--violet-400)]', peer: 'text-[var(--violet-400)]' } as const;

/**
 * `14:07:12`, in the viewer's own locale — what `toLocaleTimeString(undefined, { hour12: false })` says. `null` for a row
 * with no recorded time. ONE formatter for every row (genie#1340): `toLocaleTimeString` builds an ICU formatter per
 * call, and with every visible row drawn per push it was the hottest function in the window (9.4 s of 76 s busy).
 */
const CLOCK = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: 'numeric', second: 'numeric', hour12: false });
function timeOf(at: number | null): string | null {
    if (at === null) return null;
    return CLOCK.format(at);
}

export interface StreamRowProps {
    row: LedgerRow;
    selected: boolean;
    /** The thought still arriving while the turn runs (the board's `Thinking…` row). */
    live?: boolean | undefined;
    /** A prose row whose words are still arriving: drawn progressively (react-fancy 5.68, ChatProse `streaming`). */
    streaming?: boolean | undefined;
    /** The stream cursor is on this row (`j`/`k`) — a focus, drawn as a ring; not the Inspector's selection. */
    cursor?: boolean | undefined;
    /** A thought opened to its whole text (click toggles it). */
    expanded?: boolean | undefined;
    onToggle?: ((id: string) => void) | undefined;
    onSelect: (id: string) => void;
    /**
     * A prose row's markup (genie#1263): what its pills may open, and the opener for a person's click on one. Absent =
     * every pill is its words.
     */
    markup?: StreamMarkup | undefined;
}

export interface StreamMarkup {
    refs: ChatRefs;
    onOpen: (target: ChatLinkTarget) => void;
}

/** MEMOISED (genie#1340): a push redraws only the rows whose props changed. Rows keep their object while unchanged
 * (core/stream-view.ts LedgerRowCache) and the Stream's callbacks are stable, so an unchanged row is skipped. */
export const StreamRow = memo(function StreamRow({ row, selected, live = false, streaming = false, cursor = false, expanded = false, onToggle, onSelect, markup }: StreamRowProps) {
    countRender('StreamRow');
    const time = timeOf(row.at);

    return (
        <div
            data-stream-row={row.id}
            data-selected={selected ? 'true' : 'false'}
            {...(cursor ? { 'data-cursor': 'true' } : {})}
            {...(row.inspectable ? { 'data-inspectable': 'true' } : {})}
            // Only an inspectable row is a control. An empty cell is not a control, and a row
            // that highlights on hover and then does nothing on click teaches people that
            // clicking is pointless here.
            {...(row.inspectable ? { role: 'button', tabIndex: 0, onClick: () => onSelect(row.id) } : {})}
            // A thought with text opens to its whole reasoning in place; a second click closes it.
            {...(!row.inspectable && row.expandable && row.full !== undefined ? { 'data-expandable': 'true', role: 'button', tabIndex: 0, 'aria-expanded': expanded, onClick: () => onToggle?.(row.id) } : {})}
            className={[
                'flex items-start gap-3 px-5 py-1 text-[13px] leading-5',
                cursor ? 'ring-1 ring-inset ring-[var(--border-2)]' : '',
                // The edit row is tinted so a file change is findable by scanning rather than
                // by reading, and a SELECTED edit gets the emerald left border from the board.
                row.tinted ? 'bg-[var(--bg-1)]' : '',
                selected ? 'bg-[var(--bg-2)] shadow-[inset_2px_0_0_var(--color-emerald-500)]' : '',
                row.inspectable ? 'cursor-pointer hover:bg-[var(--bg-2)]' : '',
            ]
                .filter(Boolean)
                .join(' ')}
        >
            {/*
             * The time column keeps its width whether or not there is a time in it, so rows do
             * not jag left and right down a stream where some came from a thread that stored no
             * timestamps. An absent time renders as EMPTY, never as `--:--:--`, which reads as
             * a clock that stopped.
             */}
            <span className="w-[62px] shrink-0 pt-0.5 font-mono text-[11px] text-[var(--fg-4)]">{time}</span>

            <Icon name={row.icon} size="sm" className={`mt-0.5 shrink-0 ${row.who ? WHO_TONE[row.who.tone] : TONE[row.tone]}`} />

            {/* The board's kind column, 40px mono — the tool's name, or the row's own kind. Empty for a message. */}
            <span {...(row.kind ? { 'data-kind': row.kind } : {})} className="w-10 shrink-0 truncate pt-0.5 font-mono text-[11px] text-[var(--fg-4)]">{row.kind ?? ''}</span>

            {row.prose ? (
                // An agent's words, drawn as the chat draws them (genie#1263): Markdown, copy buttons, cards, pills. A
                // pill opens only on the person's click (genie#1265).
                <div
                    data-stream-prose=""
                    className="flex min-w-0 flex-1 flex-col gap-1"
                    onClick={markup ? (e) => {
                        const a = (e.target as HTMLElement).closest?.('a');
                        const target = a ? chatLinkTarget(a.getAttribute('href') ?? '') : null;
                        if (!target) return;
                        e.preventDefault();
                        e.stopPropagation();
                        markup.onOpen(target);
                    } : undefined}
                >
                    {row.who ? <span data-who={row.who.tone} className={`font-mono text-[11px] ${WHO_TONE[row.who.tone]}`}>{row.who.label}</span> : null}
                    <ChatProse text={row.main} refs={markup?.refs} streaming={streaming} className="text-[13px] text-[var(--fg-1)]" />
                </div>
            ) : (
            <span
                className={[
                    'min-w-0 flex-1',
                    row.mono ? 'font-mono text-xs' : '',
                    row.italic ? 'italic text-[var(--fg-3)]' : '',
                    // A thought is ONE line and stays one line. Not on click, not while
                    // streaming — content that grows and reflows as reasoning arrives is the
                    // worst reading experience in agent UIs.
                    row.clamp ? 'truncate' : 'whitespace-pre-wrap',
                ]
                    .filter(Boolean)
                    .join(' ')}
            >
                {/* WHO spoke, on a message: a field in its colour, never a role word. */}
                {row.who ? <span data-who={row.who.tone} className={`mr-2 font-mono text-[11px] ${WHO_TONE[row.who.tone]}`}>{row.who.label}</span> : null}
                {expanded && row.full !== undefined ? <span data-thought-full="" className="block whitespace-pre-wrap">{row.full}</span> : row.main}
            </span>
            )}

            {/*
             * THE LIVE THOUGHT: a pulsing bar and the word, while the thought is still arriving. No running token
             * figure — ACP carries no per-thought count; the Δ appears once a usage report brackets the thought.
             */}
            {live ? (
                <span data-live="thinking" className="flex shrink-0 items-center gap-1.5 font-mono text-[11px] text-[var(--violet-400)]">
                    <span aria-hidden="true" className="h-1 w-6 animate-pulse rounded-full bg-[var(--violet-400)]" />
                    Thinking…
                </span>
            ) : null}

            {/* An edit's line counts as two cells — only ever from a real diff. */}
            {row.plus !== null ? <span data-plus={row.plus} className="shrink-0 font-mono text-[11px] text-[var(--success)]">+{row.plus}</span> : null}
            {row.minus !== null ? <span data-minus={row.minus} className="shrink-0 font-mono text-[11px] text-[var(--danger)]">−{row.minus}</span> : null}

            {/*
             * What is MISSING from this row's data, said once and inline — `(kind not
             * reported)`, `(arguments not reported)`. Not a dash and not a silent default,
             * which is the difference between a row that is honest about a gap and one that
             * invents a category the provider never claimed.
             */}
            {row.note ? (
                <span data-note className="shrink-0 font-mono text-[11px] text-[var(--fg-4)]">
                    {row.note}
                </span>
            ) : null}

            {row.meta ? (
                <span
                    data-meta
                    className={`shrink-0 font-mono text-[11px] ${row.metaTone === 'bad' ? 'text-[var(--danger)]' : row.metaTone === 'warn' ? 'text-[var(--warning)]' : 'text-[var(--fg-4)]'}`}
                >
                    {row.meta}
                </span>
            ) : null}
        </div>
    );
});
