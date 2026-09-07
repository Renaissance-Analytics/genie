/**
 * The banner over an agent terminal whose notice could not be typed in.
 *
 * Genie parks a notice when it is not certain the input box is empty, because
 * typing into an occupied box would fire whatever is in there as the notice's
 * turn. The banner says so and offers to send it once the box is free.
 *
 * ## Why there are two states
 *
 * The box Genie is protecting is a MODEL, built from the bytes going in, and it
 * cannot see a TUI empty its own composer. When that happens the model is stale,
 * the answer to "is it empty" is no forever, and the owner met the result: a
 * "Send nudge" button that did nothing, above an input box they could see was
 * empty, with a sentence insisting it was not (genie#333).
 *
 * So a refusal is not the end of the conversation. It hands the question to the
 * person who can actually answer it — they are looking at the box — and names
 * what saying yes will cost. Nothing here clears anything on its own.
 */
export interface PendingNudgeNoticeProps {
    terminalId: string;
    /** A previous send was refused, so Genie believes the box is occupied and
     *  only the person in front of it can say otherwise. */
    needsClear: boolean;
    onSend: (terminalId: string, options?: { clearInput?: boolean }) => void;
}

export default function PendingNudgeNotice({
    terminalId,
    needsClear,
    onSend,
}: PendingNudgeNoticeProps) {
    return (
        <div className="terminal-nudge-notice" role="status" data-testid="agentinbox-incoming">
            <span>
                <strong>Nudge waiting</strong>
                <small>
                    {needsClear
                        ? 'Genie cannot tell whether your input box is empty. Clearing it discards anything typed there.'
                        : 'Your input is untouched. Clear or send it first.'}
                </small>
            </span>
            <button
                type="button"
                onClick={() => onSend(terminalId, needsClear ? { clearInput: true } : undefined)}
            >
                {needsClear ? 'Clear input & send' : 'Send nudge'}
            </button>
        </div>
    );
}
