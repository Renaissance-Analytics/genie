import { Button } from '@particle-academy/react-fancy';
import { sendAllResultWords, sendAllWords, type SendAllState } from '../../core/send-all.js';

/**
 * ONE QUEUE, ONE ACTION (Tynn #702; the owner, beta.61: six "Not delivered" rows, each with its own buttons, "is
 * unusable"). Under the last message:
 * - messages not delivered: how many, `Send all now` (in the order written) and `Discard all`;
 * - else messages waiting behind the turn: how many, and `Send all now (stop the current turn)`, the Interrupt-and-send
 *   path: the turn ends and what waits goes next, in order.
 * Nothing waiting, nothing drawn. A message's own row keeps only a small remove, for one sent by mistake.
 *
 * SEND ALL SAYS WHAT IT DID (Tynn #1089): while it sends, `Sending 1 of 2…` and the button cannot be pressed twice; after,
 * the result of EACH message, here at the bar — kept even once nothing is left "not delivered".
 */
function SendAllReport({ sending }: { sending: SendAllState }) {
    return (
        <div data-send-all-progress={sending.running ? 'running' : 'done'} role="status" aria-live="polite" className="flex flex-col items-end gap-0.5 self-end text-[12px] text-[var(--fg-2)]">
            <span>{sendAllWords(sending)}</span>
            {sending.running ? null : sending.results.map((r) => (
                <span key={r.id} data-send-all-result={r.id} data-outcome={r.outcome} className={`flex max-w-[28rem] gap-1.5 ${r.outcome === 'failed' ? 'text-[var(--danger)]' : r.outcome === 'waiting' ? 'text-[var(--fg-3)]' : 'text-[var(--success)]'}`}>
                    <span className="truncate italic">“{r.text}”</span>
                    <span className="shrink-0">{sendAllResultWords(r)}</span>
                </span>
            ))}
        </div>
    );
}

/**
export function ChatQueueBar({ agentName, waiting, undelivered, onInterruptAndSend, onSendAll, onDiscardAll, sending }: { agentName: string; waiting: number; undelivered: number; onInterruptAndSend?: (() => void) | undefined; onSendAll?: (() => void) | undefined; onDiscardAll?: (() => void) | undefined; sending?: SendAllState | null | undefined }) {
    const bar = 'flex items-center justify-end gap-2 self-end text-[12px]';
    const button = 'rounded-lg border border-[var(--border-1)] px-2.5 py-1 text-[12px] text-[var(--fg-2)] hover:bg-[var(--bg-2)]';
    const busy = sending?.running === true;
    const report = sending ? <SendAllReport sending={sending} /> : null;
    if (undelivered > 0) {
        return (
            <>
            {report}
            <div data-chat-queue="undelivered" className={bar}>
                <span className="text-[var(--danger)]">{undelivered} not delivered</span>
                {onSendAll ? <Button size="xs" type="button" data-action="send-all" title={`Send every message not delivered to ${agentName}, in the order you wrote them`} disabled={busy} onClick={onSendAll} className="rounded-lg border border-[var(--primary-hover)] bg-[var(--primary)] px-2.5 py-1 text-[12px] text-white">{busy && sending ? sendAllWords(sending) : 'Send all now'}</Button> : null}
                {onDiscardAll ? <Button size="xs" type="button" data-action="discard-all" disabled={busy} onClick={onDiscardAll} className={button}>Discard all</Button> : null}
            </div>
            </>
        );
    }
    if (waiting > 0 && onInterruptAndSend) {
        return (
            <>
            {report}
            <div data-chat-queue="waiting" className={bar}>
                <span className="font-mono text-[11px] text-[var(--fg-3)]">{waiting} waiting</span>
                <Button size="xs" type="button" color="amber" data-action="send-all-now" title={`Stop ${agentName}'s current turn; what you sent goes next, in order`} onClick={onInterruptAndSend} className="shrink-0">Send all now (stop the current turn)</Button>
            </div>
            </>
        );
    }
    return report;
}
