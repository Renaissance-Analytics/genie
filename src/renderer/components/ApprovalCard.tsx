import { Icon, Input } from '@particle-academy/react-fancy';
import { useState } from 'react';
import type { Approval, OptionTone } from '../../core/approval.js';

/**
 * A PARKED APPROVAL — the one thing on screen that an agent is genuinely blocked on.
 *
 * ## It renders wherever the composer is, and nowhere else
 *
 * One fact can appear three times: a Deck row, a Stream row, and a chat row. `approvalPlacement`
 * decides which one is ACTIONABLE; everywhere else shows a marker. Two live sets of buttons for
 * one decision is not cosmetic — answering in one leaves the other showing a resolved question,
 * and the reader cannot tell whether their answer landed.
 *
 * ## The colours come from the protocol, never from the words
 *
 * `tone` is read from ACP's option `kind` in `core/approval.ts` and is `neutral` for anything
 * unrecognised. A provider could ship an option called *"Allow once and remember"* that denies,
 * or one in another language; a substring match on "allow" would paint a deny button green,
 * which is the single most dangerous way this surface could be wrong.
 */

const TONE: Record<OptionTone, string> = {
    ok: 'border-[var(--success)]/40 text-[var(--success)] hover:bg-[var(--success)]/10',
    bad: 'border-[var(--danger)]/40 text-[var(--danger)] hover:bg-[var(--danger)]/10',
    // Deliberately uncoloured. The reader sees the provider's own words and no claim from us
    // about what they mean.
    neutral: 'border-[var(--border-2)] text-[var(--fg-2)] hover:bg-[var(--bg-2)]',
};

export interface ApprovalCardProps {
    approval: Approval;
    /** `null` while an answer is in flight, so the buttons can stop accepting a second press. */
    answering: string | null;
    /** `note`: the person's words with the answer (beta.33 item 16) — Genie delivers them to the agent; '' = none. */
    onAnswer: (optionId: string, note: string) => void;
    /** The asking agent, for the board's heading `atlas asks to run Bash`; without it the heading names the tool alone. */
    agentName?: string | undefined;
}

/** The board's key hints on the two decisions the keys reach (§4.2 `a` / `d`). */
const KEY_HINT: Partial<Record<OptionTone, string>> = { ok: 'A', bad: 'D' };

/**
 * THE NOTE (beta.33 item 16; the owner: "I rejected with a note in the rejection but compass did not get the rejection
 * notice"): every approval takes one, optional, sent with whichever option is pressed. Held here; the card itself is
 * hook-free (`ApprovalCardView`), so a test can press it.
 */
export function ApprovalCard(props: ApprovalCardProps) {
    const [note, setNote] = useState('');
    return <ApprovalCardView {...props} note={note} onNote={setNote} />;
}

export function ApprovalCardView({ approval, answering, onAnswer, agentName, note, onNote }: ApprovalCardProps & { note: string; onNote: (note: string) => void }) {
    // The board's heading and meta, each only when the request reported the piece; the question itself always.
    const heading = approval.tool ? `${agentName ? `${agentName} asks` : 'asks'} to run ${approval.tool}` : null;
    const meta = approval.toolCallId ? `tool_call ${approval.toolCallId.replace(/^toolu_/, '').slice(0, 4)} · 1 of 1 pending` : null;
    return (
        <div
            data-approval
            className="m-3 rounded-lg border border-[var(--warning)]/40 bg-[var(--warning)]/5 p-3 text-[13px]"
        >
            {heading ? (
                <div className="mb-1 flex items-center gap-2">
                    <span data-approval-heading="" className="text-[13px] font-semibold text-[var(--fg-1)]">{heading}</span>
                    {meta ? <span data-approval-meta="" className="font-mono text-[11px] text-[var(--fg-4)]">{meta}</span> : null}
                </div>
            ) : null}
            <div className="mb-2 flex items-start gap-2">
                <Icon name="circle-help" size="sm" className="mt-0.5 shrink-0 text-[var(--warning)]" />
                <span data-approval-question className="min-w-0 flex-1 font-mono text-xs text-[var(--fg-1)]">
                    {approval.question}
                </span>
            </div>
            {approval.command && approval.command !== approval.question ? (
                <pre data-approval-command="" className="mb-2 overflow-x-auto rounded-md bg-[var(--bg-2)] px-2.5 py-1.5 font-mono text-[11px] leading-[17px] text-[var(--fg-2)]">{approval.command}</pre>
            ) : approval.command ? (
                <pre data-approval-command="" className="hidden">{approval.command}</pre>
            ) : null}

            {/* An optional note, sent with the answer — the agent is told "You rejected …: <note>" (item 16). */}
            <Input
                data-approval-note=""
                value={note}
                onValueChange={onNote}
                size="sm"
                placeholder={agentName ? `Note for ${agentName} (optional) — sent with your answer` : 'Note (optional) — sent with your answer'}
                aria-label="Note with your answer"
                className="mb-2"
            />
            <div className="flex flex-wrap gap-2">
                {approval.options.map((option) => (
                    <button
                        key={option.id}
                        type="button"
                        data-approval-option={option.id}
                        data-tone={option.tone}
                        // Once an answer is in flight the buttons stop accepting a second press.
                        // The provider is blocked on a single promise; a second answer resolves
                        // nothing and the second press would look ignored.
                        disabled={answering !== null}
                        onClick={() => onAnswer(option.id, note)}
                        className={`rounded-md border px-2.5 py-1 text-xs disabled:opacity-50 ${TONE[option.tone]}`}
                    >
                        {option.label}
                        {KEY_HINT[option.tone] ? <span data-key-hint={KEY_HINT[option.tone]} className="ml-1.5 rounded-sm border border-current/30 px-1 font-mono text-[10px] opacity-70">{KEY_HINT[option.tone]}</span> : null}
                    </button>
                ))}
            </div>
        </div>
    );
}

/**
 * The MARKER, for everywhere the approval is not actionable.
 *
 * It says a decision is parked and where to make it. A surface that showed nothing would leave
 * someone reading a stream that has silently stopped, which is the worst version of this: the
 * agent looks idle and is in fact waiting on them.
 */
export function ApprovalMarker({ where }: { where: string }) {
    return (
        <div data-approval-marker className="m-3 flex items-center gap-2 rounded-md border border-[var(--border-1)] px-3 py-1.5 text-xs text-[var(--warning)]">
            <Icon name="circle-help" size="xs" className="shrink-0" />
            This agent is waiting on a decision — answer it in {where}.
        </div>
    );
}
