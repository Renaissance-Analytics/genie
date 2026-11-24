import { useEffect, useState, type ReactNode } from 'react';
import { Button, Input, Switch } from '@particle-academy/react-fancy';
import { APP_LIMITS, parseAppWakeCap, type AppWakeCap } from '../../core/app-inbox.js';

/**
 * THE APP WAKE CAP, IN THE AGENT'S SETTINGS (Tynn #1053): how many turns an hour mail from the workspace's apps may give
 * this agent — a number, or no limit. One row on General: the number, Set, a "No limit" switch and one line saying what
 * it is. It draws the cap the host answered (the agent's detail) and keeps only what is being typed; a number the host
 * would refuse is not sent, and the row says why in the host's own words (`parseAppWakeCap`). "No limit" sends the word
 * `unlimited`, never a zero or a blank.
 */
export interface AppWakeCapControlProps {
    readonly agentName: string;
    /** The cap in force, as the host answered it. */
    readonly cap: AppWakeCap;
    readonly onSet: (cap: AppWakeCap) => void;
    /** What the host said of the last change, drawn at the row's end (the settings view's own outcome). */
    readonly outcome?: ReactNode;
}

export function AppWakeCapControl({ agentName, cap, onSet, outcome }: AppWakeCapControlProps) {
    const unlimited = cap === 'unlimited';
    const shown = unlimited ? String(APP_LIMITS.wakeTurns) : String(cap);
    const [draft, setDraft] = useState(shown);
    // The host's answer replaces what was typed: a change made on another window is shown here too.
    useEffect(() => { setDraft(shown); }, [shown]);

    const text = draft.trim();
    const parsed = parseAppWakeCap(/^-?\d+(\.\d+)?$/.test(text) ? Number(text) : null);
    const changed = text !== shown;
    const refusal = !unlimited && changed && !parsed.ok ? parsed.reason : null;
    const send = (): void => {
        if (unlimited || !changed || !parsed.ok) return;
        onSet(parsed.cap);
    };
    const help = `Mail from this workspace’s apps gives ${agentName} at most this many turns an hour; more of it waits, and none is lost.`;

    return (
        <div data-settings-row="app-wake-cap" data-app-wake-cap={String(cap)} className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-[var(--border-1)] py-2 last:border-b-0">
            <span className="w-44 shrink-0 text-[var(--fg-2)]">App mail turns</span>
            <Input
                size="sm"
                type="number"
                min={1}
                step={1}
                value={draft}
                disabled={unlimited}
                onValueChange={setDraft}
                onKeyDown={(event) => { if (event.key === 'Enter') send(); }}
                data-app-wake-cap-input=""
                aria-label={`App mail turns an hour for ${agentName}`}
                className="w-20"
            />
            <span className="text-[var(--fg-3)]">an hour</span>
            <Button size="xs" type="button" data-action="app-wake-cap-set" disabled={unlimited || !changed} onClick={send} className="rounded-md border border-[var(--border-1)] px-2 py-0.5 hover:bg-[var(--bg-2)]">
                Set
            </Button>
            <span className="flex items-center gap-1.5 text-[var(--fg-2)]">
                <Switch checked={unlimited} onCheckedChange={(on) => onSet(on ? 'unlimited' : APP_LIMITS.wakeTurns)} aria-label={`No limit on app mail turns for ${agentName}`} />
                No limit
            </span>
            {refusal ? <span data-app-wake-cap-refusal="" className="text-[11px] text-[var(--warning)]">{refusal}</span> : null}
            <span data-app-wake-cap-help="" className="min-w-0 flex-1 truncate text-[11px] text-[var(--fg-4)]" title={help}>{help}</span>
            {outcome}
        </div>
    );
}
