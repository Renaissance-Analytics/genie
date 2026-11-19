import { Button, Icon } from '@particle-academy/react-fancy';
import { runningCallWords, type RunningCall as Call } from '../../core/hung-call.js';

/**
 * THE CALL THE TURN IS IN (Tynn #855): its label, command and age, beside `Stop this call`. lift's az/gh/git call hung 21
 * minutes and the only way out was to stop the whole turn; this ends just that call — its own processes — and the agent
 * is told and carries on. Hook-free, so a test renders and presses it without a DOM.
 */
export function RunningCall({ call, now, onStop }: { call: Call; now: number; onStop?: (() => void) | undefined }) {
    const words = runningCallWords(call, now);
    return (
        <span data-running-call={call.toolCallId} className="flex min-w-0 items-center gap-1.5 rounded-md border border-[var(--border-1)] px-2 py-0.5 text-xs text-[var(--fg-2)]">
            <Icon name="square-terminal" size="xs" />
            <span className="min-w-0 truncate font-mono" title={call.command ?? call.label}>{words}</span>
            {onStop ? (
                <Button size="xs" labelClassName="contents"
                    type="button"
                    data-action="stop-call"
                    title="Stop this call: only this call ends; the agent is told and its turn goes on"
                    onClick={() => onStop()}
                    className="flex shrink-0 items-center gap-1 whitespace-nowrap rounded-md border border-[var(--border-1)] px-1.5 py-0 text-xs text-[var(--fg-1)] hover:bg-[var(--bg-2)]"
                >
                    <Icon name="square" size="xs" />
                    Stop this call
                </Button>
            ) : null}
        </span>
    );
}
