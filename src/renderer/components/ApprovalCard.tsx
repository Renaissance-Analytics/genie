import { Icon } from '@particle-academy/react-fancy';
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
    onAnswer: (optionId: string) => void;
}

export function ApprovalCard({ approval, answering, onAnswer }: ApprovalCardProps) {
    return (
        <div
            data-approval
            className="m-3 rounded-lg border border-[var(--warning)]/40 bg-[var(--warning)]/5 p-3 text-[13px]"
        >
            <div className="mb-2 flex items-start gap-2">
                <Icon name="circle-help" size="sm" className="mt-0.5 shrink-0 text-[var(--warning)]" />
                <span data-approval-question className="min-w-0 flex-1 font-mono text-xs text-[var(--fg-1)]">
                    {approval.question}
                </span>
            </div>

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
                        onClick={() => onAnswer(option.id)}
                        className={`rounded-md border px-2.5 py-1 text-xs disabled:opacity-50 ${TONE[option.tone]}`}
                    >
                        {option.label}
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
