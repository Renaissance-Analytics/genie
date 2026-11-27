import { Button, Icon } from '@particle-academy/react-fancy';
import { useEffect, useState } from 'react';
import { CUE_LOOK, cueAge, cueVerb, unseenCues, workspaceLog, type CueTone, type SoundCue } from '../../core/sound-cues.js';
import { useSoundCues } from '../sound-cues-context.js';

/**
 * WHAT SOUNDED, ON SCREEN (Tynn #1057): a cue's icon (CUE_LOOK) wherever it is shown, and the activity strip the
 * Dashboard and each workspace dashboard draw. Icons over words: each entry is its icon and who; its words are its tooltip.
 *
 * These are the window's own record of what sounded, apart from Genie's notices (the toasts, Tynn #1068): a notice says
 * something once; a cue stays until it is seen.
 */

export const CUE_TONE: Readonly<Record<CueTone, string>> = {
    needs: 'text-[var(--warning)]',
    bad: 'text-[var(--danger)]',
    ok: 'text-[var(--success)]',
    info: 'text-[var(--accent,var(--fg-1))]',
    muted: 'text-[var(--fg-3)]',
};

/** The cue in words: what, who, and what happened — its tooltip and accessible name. */
export function cueWords(cue: SoundCue): string {
    const what = cueVerb(cue.kind);
    const detail = cue.detail && cue.detail !== what ? ` — ${cue.detail}` : '';
    return `${what}${cue.who ? ` · ${cue.who}` : ''}${detail}`;
}

/** A cue's icon, in its tone; `data-sound-cue` names the kind (what the guard test reads). */
export function CueIcon({ cue, size = 'xs', className = '' }: { cue: SoundCue; size?: 'xs' | 'sm'; className?: string }) {
    const look = CUE_LOOK[cue.kind];
    return <Icon name={look.icon} size={size} data-sound-cue={cue.kind} className={`shrink-0 ${CUE_TONE[look.tone]} ${className}`} />;
}

/**
 * THE SLOT a sidebar row keeps for its cue: the icon of its most recent unseen event, or nothing — an empty slot of the
 * same width, so the names stay in one column.
 */
export function CueSlot({ cue, size = 'sm' }: { cue: SoundCue | null; size?: 'xs' | 'sm' }) {
    return (
        <span data-cue-slot={cue?.kind ?? ''} {...(cue ? { title: cueWords(cue) } : { 'aria-hidden': true })} className="inline-flex size-4 shrink-0 items-center justify-center">
            {cue ? <CueIcon cue={cue} size={size} /> : null}
        </span>
    );
}

/** The cue at an icon's corner: the collapsed rail's, where the row is its icon alone. */
export function CueCorner({ cue }: { cue: SoundCue | null }) {
    if (!cue) return null;
    return (
        <span data-cue-corner={cue.kind} title={cueWords(cue)} className="absolute -bottom-0.5 -right-0.5 flex size-3.5 items-center justify-center rounded-full bg-[var(--bg-1)]">
            <CueIcon cue={cue} size="xs" className="size-3" />
        </span>
    );
}

/** The clock the ages are read against, once a minute: an entry's "3m" moves without anything else changing. */
function useMinute(): number {
    const [now, setNow] = useState(() => Date.now());
    useEffect(() => { const t = setInterval(() => setNow(Date.now()), 60_000); return () => clearInterval(t); }, []);
    return now;
}

/** How many entries a strip shows before it says how many more. */
const STRIP_MAX = 14;

/**
 * THE ACTIVITY: what sounded, newest first, each entry a door to what it is about (opening it sees it) with its own
 * clear (the Deck's rule: dealt with where it is shown). The Dashboard's shows what is UNSEEN, everywhere, and is not drawn
 * when nothing is (the signal strip's rule: silent unless something is true). A workspace dashboard's shows what happened
 * there and to the whole machine, seen ones too, dimmed — arriving at the workspace is what sees them.
 */
export function SoundActivity({ scope }: { scope: 'dashboard' | { workspaceId: string } }) {
    const { cues, onOpen, onSee, onSeeAll } = useSoundCues();
    const now = useMinute();
    const list = scope === 'dashboard' ? unseenCues(cues) : workspaceLog(cues, scope.workspaceId, STRIP_MAX);
    if (list.length === 0) return null;
    const shown = list.slice(0, STRIP_MAX);
    const more = list.length - shown.length;
    const unseen = list.filter((c) => !c.seen).length;
    const label = scope === 'dashboard' ? `${unseen} unseen event${unseen === 1 ? '' : 's'}` : 'Recent events';
    return (
        <div data-sound-activity={scope === 'dashboard' ? 'dashboard' : scope.workspaceId} role="list" aria-label={label}
            // The Dashboard's is a band under its header, edge to edge like its signal strip; a workspace dashboard's is a card
            // in its column, like the lanes under it.
            className={`flex shrink-0 flex-wrap items-center gap-1.5 ${scope === 'dashboard' ? 'border-b border-[var(--border-1)] px-7 py-1.5' : 'rounded-lg border border-[var(--border-1)] bg-[var(--bg-1)] px-3 py-2'}`}>
            <span title={label} className="flex shrink-0 items-center gap-1 text-[var(--fg-3)]">
                <Icon name="bell" size="xs" />
                {unseen > 0 ? <span data-sound-unseen={unseen} className="font-mono text-[11px] tabular-nums">{unseen}</span> : null}
            </span>
            {shown.map((cue) => (
                <span key={cue.id} role="listitem" data-cue-id={cue.id} data-cue-kind={cue.kind} data-cue-seen={String(cue.seen)}
                    className={`group flex h-6 min-w-0 items-center rounded-md border ${cue.seen ? 'border-transparent opacity-55' : 'border-[var(--border-1)] bg-[var(--bg-2)]'}`}>
                    <Button type="button" variant="ghost" size="xs" labelClassName="contents" data-cue-open={cue.id} title={cueWords(cue)} aria-label={cueWords(cue)}
                        onClick={() => onOpen?.(cue)} className="flex h-6 min-w-0 items-center gap-1 px-1.5">
                        <CueIcon cue={cue} />
                        {cue.who ? <span className="max-w-[9rem] truncate text-[11px] text-[var(--fg-2)]">{cue.who}</span> : null}
                        <span className="font-mono text-[10px] text-[var(--fg-4)]">{cueAge(cue.at, now)}</span>
                    </Button>
                    {!cue.seen && onSee ? (
                        <Button type="button" variant="ghost" size="xs" labelClassName="contents" data-cue-see={cue.id} title="Seen" aria-label={`Seen: ${cueWords(cue)}`}
                            onClick={() => onSee(cue.id)} className="flex size-5 items-center justify-center p-0 text-[var(--fg-4)] hover:text-[var(--fg-1)]">
                            <Icon name="x" size="xs" />
                        </Button>
                    ) : null}
                </span>
            ))}
            {more > 0 ? <span data-sound-more={more} className="font-mono text-[11px] text-[var(--fg-4)]">+{more}</span> : null}
            {unseen > 0 && onSeeAll && scope === 'dashboard' ? (
                <Button type="button" variant="ghost" size="xs" labelClassName="contents" data-cue-see-all="" title="All seen" aria-label="Mark every event seen"
                    onClick={onSeeAll} className="ml-auto flex size-6 items-center justify-center p-0 text-[var(--fg-3)] hover:text-[var(--fg-1)]">
                    <Icon name="check-check" size="sm" />
                </Button>
            ) : null}
        </div>
    );
}
