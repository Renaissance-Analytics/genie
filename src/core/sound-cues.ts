import { ALERT_KINDS, legacySoundChoice, type AlertKind } from './alerts.js';
import { parseRoute } from './route.js';

/**
 * EVERY SOUND HAS A SIGHT (Tynn #1057; the owner, 2026-11-24: "genie event that makes a sound should have a visual
 * representation in the side bar and dashboard and workspace dashboard"; 2026-11-26: "I still have genie events that emit
 * sounds but with no visual cues").
 *
 * A CUE is what is left on screen of an event that sounds: an icon on the row of the agent or workspace it happened in
 * (the sidebar), and an entry in the Dashboard's activity and the workspace dashboard's. It is kept by the window, newest
 * first, at most {@link CUE_LOG}; this file is its rules and its looks. No React, no Electron.
 *
 * ## Which events
 *
 * Every row of Settings → Notifications & sounds (ALERT_KINDS) and the rate-limit alert (Tynn #748, its own sound): the
 * keys are DERIVED from ALERT_KINDS, so a sound added there has no look here until it is given one, and
 * test/sound-cues-1057.test.tsx fails until it is. An event is cued when its row is set to a sound — not None — whatever
 * the master switch, Do not disturb or the volume say: those decide what reaches the speakers, and the person this is for
 * may have the sound off, or be away from the speakers.
 *
 * ## Seen — the Deck's rule
 *
 * A cue stays until it is dealt with, and it can be dealt with where it is shown, without navigating (the Deck's
 * acceptance sentence, core/deck.ts): cleared in place on the Dashboard, one or all. Going to it sees it too — the
 * workspace pulse's rule (core/view-requests.ts `arrive`): arriving at a workspace sees what happened there, its agents'
 * included; opening an agent (its page, or its chat) sees that agent's. The Dashboard itself sees nothing: being on the
 * board is not having read the strip.
 */
export type CueKind = AlertKind | 'ratelimit';

/** needs: someone waits on you · bad: something broke or stopped on its own · ok: done, up · info: it did something · muted: background. */
export type CueTone = 'needs' | 'bad' | 'ok' | 'info' | 'muted';

export interface CueLook {
    /** A name in renderer/icons.ts ICON_NAMES (icons over words: the owner's rule). */
    readonly icon: string;
    readonly tone: CueTone;
}

/** Every sound event key: each Notifications & sounds row, then the rate-limit alert. */
export const CUE_KINDS: readonly CueKind[] = [...ALERT_KINDS.map((k) => k.kind), 'ratelimit'];

/** Each one's icon, one per kind so a glance tells them apart, and its tone. */
export const CUE_LOOK: Readonly<Record<CueKind, CueLook>> = {
    question: { icon: 'message-circle-question', tone: 'needs' },
    approval: { icon: 'hand', tone: 'needs' },
    broken: { icon: 'octagon-x', tone: 'bad' },
    limited: { icon: 'pause', tone: 'needs' },
    started: { icon: 'play', tone: 'ok' },
    replied: { icon: 'message-circle-reply', tone: 'info' },
    finished: { icon: 'circle-check-big', tone: 'ok' },
    thumbsup: { icon: 'thumbs-up', tone: 'ok' },
    stopped: { icon: 'circle-stop', tone: 'muted' },
    resumed: { icon: 'timer-reset', tone: 'ok' },
    edits: { icon: 'pencil', tone: 'info' },
    runs: { icon: 'square-terminal', tone: 'info' },
    reads: { icon: 'file-search', tone: 'muted' },
    fetches: { icon: 'globe', tone: 'info' },
    plans: { icon: 'list-checks', tone: 'info' },
    mail: { icon: 'mail', tone: 'needs' },
    agentmail: { icon: 'send', tone: 'info' },
    exits: { icon: 'circle-x', tone: 'bad' },
    siteup: { icon: 'server', tone: 'ok' },
    sitedown: { icon: 'server-off', tone: 'bad' },
    serviceup: { icon: 'database', tone: 'ok' },
    flowdone: { icon: 'workflow', tone: 'ok' },
    ghissue: { icon: 'circle-dot', tone: 'info' },
    ghpr: { icon: 'git-pull-request', tone: 'info' },
    ghsecurity: { icon: 'shield-alert', tone: 'bad' },
    ghci: { icon: 'bug', tone: 'bad' },
    ratelimit: { icon: 'gauge', tone: 'needs' },
};

/** What a kind is called on its tooltip: the alert's own verb (the toast's), the rate-limit alert's name. */
export function cueVerb(kind: CueKind): string {
    return kind === 'ratelimit' ? 'Rate limit' : ALERT_KINDS.find((k) => k.kind === kind)?.verb ?? kind;
}

export interface SoundCue {
    readonly id: string;
    readonly kind: CueKind;
    /** The workspace it happened in; `null` = none (a shared service, the toolchain, a rate limit, GitHub). */
    readonly workspaceId: string | null;
    /** The agent it was; `null` = no agent's. */
    readonly agentId: string | null;
    /** Who, in words: the agent's name, else what raised it (Toolchain); `null` = nobody to name. */
    readonly who: string | null;
    /** One line: what happened. */
    readonly detail: string;
    readonly at: number;
    readonly seen: boolean;
}

export type SoundCues = readonly SoundCue[];
export type NewCue = Omit<SoundCue, 'seen'>;
export const NO_CUES: SoundCues = Object.freeze([]);

/** How many the window keeps: the newest, seen or not. A workspace dashboard's log is cut from these. */
export const CUE_LOG = 60;

/** A cue's place: a workspace (its agents' included), one agent, or the machine (no workspace, no agent). */
export type CueWhere = { readonly workspaceId: string } | { readonly agentId: string } | 'machine';

export function addCue(cues: SoundCues, cue: NewCue): SoundCues {
    return [{ ...cue, seen: false }, ...cues.filter((c) => c.id !== cue.id)].slice(0, CUE_LOG);
}

/** The ones `which` picks marked seen; the same list back when none of them was unseen, so nothing re-renders. */
function see(cues: SoundCues, which: (c: SoundCue) => boolean): SoundCues {
    if (!cues.some((c) => !c.seen && which(c))) return cues;
    return cues.map((c) => (!c.seen && which(c) ? { ...c, seen: true } : c));
}

/** The person is at `route`: a workspace's page sees what happened there; an agent's page sees that agent's. */
export function seeRoute(cues: SoundCues, route: string): SoundCues {
    const at = parseRoute(route);
    if (at.surface === 'workspace') return see(cues, (c) => c.workspaceId === at.workspaceId);
    if (at.surface === 'agent') return seeAgent(cues, at.agentId);
    return cues;
}

/** The agent's chat or page was opened. */
export function seeAgent(cues: SoundCues, agentId: string): SoundCues {
    return see(cues, (c) => c.agentId === agentId);
}

export function seeCue(cues: SoundCues, id: string): SoundCues {
    return see(cues, (c) => c.id === id);
}

export function seeAll(cues: SoundCues): SoundCues {
    return see(cues, () => true);
}

function isAt(c: SoundCue, where: CueWhere): boolean {
    if (where === 'machine') return c.workspaceId === null && c.agentId === null;
    if ('agentId' in where) return c.agentId === where.agentId;
    return c.workspaceId === where.workspaceId;
}

/** What is unseen, newest first: everywhere, or at one place. */
export function unseenCues(cues: SoundCues, where?: CueWhere): SoundCue[] {
    return cues.filter((c) => !c.seen && (where === undefined || isAt(c, where)));
}

/** The newest unseen at a place: what its sidebar row shows. */
export function latestUnseen(cues: SoundCues, where: CueWhere): SoundCue | null {
    return cues.find((c) => !c.seen && isAt(c, where)) ?? null;
}

/** A workspace dashboard's activity: what happened in it and what happened to the whole machine, seen ones too, newest first. */
export function workspaceLog(cues: SoundCues, workspaceId: string, n = 12): SoundCue[] {
    return cues.filter((c) => c.workspaceId === workspaceId || (c.workspaceId === null && c.agentId === null)).slice(0, n);
}

/** Whether an event of `kind` is cued: its row is set to a sound (not None). The master switch, DND and volume are the speakers'. */
export function cueWanted(kind: AlertKind, settings: Readonly<Record<string, boolean | string | undefined>>): boolean {
    const def = ALERT_KINDS.find((k) => k.kind === kind);
    if (!def) return false;
    const raw = settings[`sound_${kind}`];
    const value = raw === undefined ? def.sound : legacySoundChoice(`sound_${kind}`, raw);
    return value !== 'off';
}

/** What `genie:action` carries, as far as a cue reads it. */
export interface CueAction {
    readonly agentId: string | null;
    readonly kind: string;
    readonly workspaceId?: string | undefined;
    readonly title?: string | undefined;
    readonly body?: string | undefined;
    readonly reason?: string | undefined;
    readonly tool?: string | undefined;
}

export interface CueAgent { readonly id: string; readonly name: string; readonly workspaceId: string }

const isAlertKind = (kind: string): kind is AlertKind => ALERT_KINDS.some((k) => k.kind === kind);

/**
 * The cue of an action the window was sent (App's `onAction`): the rate-limit alert, or an action of a sound row — an
 * agent's on that agent and its workspace, an agentless thing on the workspace it names, or on none. Anything else is not
 * a sound and has no cue.
 */
export function cueOfAction(action: CueAction, agents: readonly CueAgent[], at: number, id: string): NewCue | null {
    if (action.kind === 'limit-alert') {
        return { id, kind: 'ratelimit', workspaceId: null, agentId: null, who: null, detail: action.title || cueVerb('ratelimit'), at };
    }
    if (!isAlertKind(action.kind)) return null;
    const agent = action.agentId === null ? undefined : agents.find((a) => a.id === action.agentId);
    const workspaceId = agent?.workspaceId ?? (typeof action.workspaceId === 'string' && action.workspaceId !== '' ? action.workspaceId : null);
    const said = action.reason ?? action.tool;
    return {
        id,
        kind: action.kind,
        workspaceId,
        agentId: action.agentId,
        who: agent?.name ?? null,
        detail: said ? `${cueVerb(action.kind)}: ${said}` : cueVerb(action.kind),
        at,
    };
}

/** The workspace an alert names, when it names one: `—` is none, and so is the toolchain's. */
const NO_WORKSPACE = new Set(['—', '']);

/** The cue of a Deck or board alert (core/alert-diff.ts) or the toolchain's: on the agent that raised it, if any. */
export function cueOfAlert(alert: { kind: AlertKind; workspace: string; agent: string; detail: string; agentId?: string | null | undefined }, at: number, id: string): NewCue {
    return {
        id,
        kind: alert.kind,
        workspaceId: NO_WORKSPACE.has(alert.workspace) ? null : alert.workspace,
        agentId: alert.agentId ?? null,
        who: alert.agent === '—' ? null : alert.agent,
        detail: alert.detail,
        at,
    };
}

/** "3 min ago", short: what a cue's entry says beside it. */
export function cueAge(at: number, now: number): string {
    const s = Math.max(0, Math.round((now - at) / 1000));
    if (s < 60) return 'now';
    const m = Math.round(s / 60);
    if (m < 60) return `${m}m`;
    const h = Math.round(m / 60);
    return h < 24 ? `${h}h` : `${Math.round(h / 24)}d`;
}
