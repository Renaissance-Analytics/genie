import { Button, Callout, Icon } from '@particle-academy/react-fancy';
import { useEffect, useState } from 'react';
import { SILENT_CALL_MS, silentCall, silentCallWords, type RunningCall, type SilentCall as Silent } from '../../core/hung-call.js';

/**
 * A CALL THAT HAS GONE SILENT, AT ITS OWN ENTRY IN THE STREAM (Tynn #950). The owner on beta.65: "I don't need to see the
 * workstream in the freaking header" — #855 had put every running call's command, its age and `Stop this call` in the
 * agent's bar. Now the bar holds the agent's state only, and only a call that has printed nothing for two minutes is
 * shown, here, under its own row: its name, how long it has been quiet, and `Stop this call` (#855's stop, unchanged:
 * only that call's processes end, the agent is told, its turn goes on). Its command is on the row above, so it is not
 * repeated. A status, not an alert: the minutes tick, and a live region that shouts each tick would be noise.
 *
 * Hook-free, so a test renders and presses it without a DOM.
 */
export function SilentCall({ call, onStop }: { call: Silent; onStop?: (() => void) | undefined }) {
    return (
        <div data-silent-entry="" className="px-5 pb-1.5 pl-[4.5rem]">
            <Callout
                color="amber"
                role="status"
                data-silent-call={call.toolCallId}
                icon={<Icon name="hourglass" size="xs" />}
                className="items-center gap-2 rounded-md border-l-2 px-2.5 py-1 text-xs"
            >
                <span className="flex min-w-0 items-center gap-2">
                    <span className="min-w-0 truncate">
                        <span className="font-mono font-medium">{call.label}</span>
                        <span className="mx-1.5 opacity-50" aria-hidden="true">·</span>
                        <span data-silent-for="" className="tabular-nums">{silentCallWords(call)}</span>
                    </span>
                    {onStop ? (
                        <Button
                            type="button"
                            size="xs"
                            icon="square"
                            data-action="stop-call"
                            title="Stop this call: only this call ends; the agent is told and its turn goes on"
                            onClick={() => onStop()}
                            className="ml-auto shrink-0 whitespace-nowrap"
                        >
                            Stop this call
                        </Button>
                    ) : null}
                </span>
            </Callout>
        </div>
    );
}

const MIN = 60_000;

/**
 * The running call as a silent call, kept current while NOTHING arrives: silence brings no events, so nothing else would
 * draw the view again. One timer at a time, only while a call runs: at the moment it crosses SILENT_CALL_MS, then once a
 * minute (when its minutes change). `null` = no call, or not silent yet.
 */
export function useSilentCall(call: RunningCall | null | undefined, lastEventAt: number | null | undefined, now: () => number): Silent | null {
    const [, redraw] = useState(0);
    const at = now();
    const silent = silentCall(call, lastEventAt, at);
    const from = call ? (typeof lastEventAt === 'number' ? Math.max(call.since, lastEventAt) : call.since) : null;
    useEffect(() => {
        if (from === null) return;
        const quiet = now() - from;
        const wait = quiet < SILENT_CALL_MS ? SILENT_CALL_MS - quiet : MIN - (quiet % MIN);
        const id = setTimeout(() => redraw((n) => n + 1), Math.max(250, wait + 50));
        return () => clearTimeout(id);
    });
    return silent;
}
