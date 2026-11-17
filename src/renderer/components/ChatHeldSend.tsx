import { Button } from '@particle-academy/react-fancy';
import type { HeldSend } from '../../core/send-grace.js';

/**
 * MESSAGES HELD FOR THE UNDO WINDOW (Tynn #745, core/send-grace.ts): drawn where the message will be — as your message,
 * at the end of the thread — with the seconds left, Undo and Send now. Once it has gone to the host it reads Sending
 * until the thread's own copy takes its place, so nothing below it moves.
 */
export function ChatHeldSends({ held, now, onUndo, onSendNow }: { held: readonly HeldSend[]; now: number; onUndo: (id: string) => void; onSendNow: (id: string) => void }) {
    if (held.length === 0) return null;
    return (
        <>
            {held.map((h) => (
                <div key={h.id} data-chat-held={h.id} data-who="you" className="flex max-w-[86%] flex-col items-end gap-1 self-end">
                    <div className="font-mono text-[11px] text-[var(--fg-3)]">you</div>
                    <div data-chat-user-text="" className="whitespace-pre-wrap break-words rounded-[10px] border border-dashed border-[var(--border-2)] bg-[var(--bg-2)] px-2.5 py-2 text-[13px] leading-normal opacity-80">{h.text}</div>
                    <span className="flex h-5 items-center justify-end gap-1.5 font-mono text-[11px] text-[var(--fg-3)]">
                        {h.sending ? <span>Sending</span> : (
                            <>
                                <span>Sending in {Math.max(1, Math.ceil((h.until - now) / 1000))} s</span>
                                <Button size="xs" variant="ghost" type="button" data-action="undo-send" data-held={h.id} onClick={() => onUndo(h.id)} className="h-auto px-1 py-0 text-[11px] text-[var(--fg-1)]">Undo</Button>
                                <Button size="xs" variant="ghost" type="button" data-action="send-now" data-held={h.id} onClick={() => onSendNow(h.id)} className="h-auto px-1 py-0 text-[11px] text-[var(--fg-2)]">Send now</Button>
                            </>
                        )}
                    </span>
                </div>
            ))}
        </>
    );
}
