import { Icon } from '@particle-academy/react-fancy';
import type { LedgerRow, Tone } from '../../core/stream-view.js';

/**
 * ONE LEDGER ROW — time, icon, main, meta.
 *
 * Every decision about what this row says is already made in `stream-view.ts` and tested
 * without a DOM. This turns a `LedgerRow` into markup and makes no judgements of its own.
 */

const TONE: Record<Tone, string> = {
    default: 'text-[var(--fg-1)]',
    muted: 'text-[var(--fg-3)]',
    violet: 'text-violet-400',
    emerald: 'text-emerald-500',
    sky: 'text-sky-400',
    amber: 'text-amber-500',
    bad: 'text-red-500',
};

/** The speaker's colour (the board): you blue, the agent violet, a peer violet too — it is an agent. */
const WHO_TONE = { you: 'text-blue-500', agent: 'text-violet-400', peer: 'text-violet-400' } as const;

/** `14:07:12`, in the viewer's own locale. `null` for a row with no recorded time. */
function timeOf(at: number | null): string | null {
    if (at === null) return null;
    return new Date(at).toLocaleTimeString(undefined, { hour12: false });
}

export interface StreamRowProps {
    row: LedgerRow;
    selected: boolean;
    onSelect: (id: string) => void;
}

export function StreamRow({ row, selected, onSelect }: StreamRowProps) {
    const time = timeOf(row.at);

    return (
        <div
            data-stream-row={row.id}
            data-selected={selected ? 'true' : 'false'}
            {...(row.inspectable ? { 'data-inspectable': 'true' } : {})}
            // Only an inspectable row is a control. An empty cell is not a control, and a row
            // that highlights on hover and then does nothing on click teaches people that
            // clicking is pointless here.
            {...(row.inspectable ? { role: 'button', tabIndex: 0, onClick: () => onSelect(row.id) } : {})}
            className={[
                'flex items-start gap-3 px-5 py-1 text-[13px] leading-5',
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
                {row.main}
            </span>

            {/* An edit's line counts as two cells — only ever from a real diff. */}
            {row.plus !== null ? <span data-plus={row.plus} className="shrink-0 font-mono text-[11px] text-emerald-500">+{row.plus}</span> : null}
            {row.minus !== null ? <span data-minus={row.minus} className="shrink-0 font-mono text-[11px] text-red-500">−{row.minus}</span> : null}

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
                    className={`shrink-0 font-mono text-[11px] ${row.metaTone === 'bad' ? 'text-red-500' : row.metaTone === 'warn' ? 'text-amber-500' : 'text-[var(--fg-4)]'}`}
                >
                    {row.meta}
                </span>
            ) : null}
        </div>
    );
}
