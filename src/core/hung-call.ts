import type { DeckItem } from './deck.js';
import type { ProcessInfo } from './process-tree.js';

/**
 * A HUNG TOOL CALL, A HUNG TURN (Tynn #855). Two real cases:
 *   - lift (2026-11-18): a foreground az/gh/git call hung ~21 minutes; the only way out was to stop the whole turn.
 *   - prism-engine (2026-11-19): "Turn 14 · running" for hours after the CLI had ended the turn — prism-acp dropped the
 *     `result` of a turn Claude started itself (prism G-313). Nothing told the person what was wrong.
 *
 * What is in here has no session: the running call as words, which processes a call started, the no-output timeout
 * setting, the stalled turn as words, and the Deck's book of stalled turns.
 */

/** The foreground call a turn is in now: what the silence notice and the agent view name. */
export interface RunningCall {
    readonly toolCallId: string;
    /** Its title, else its name (`Bash`, `mcp__genie__services`). */
    readonly label: string;
    /** Its command, when it has one (a shell call's `rawInput.command`); `null` = none was reported. */
    readonly command: string | null;
    /** Epoch ms: when Genie saw it start. */
    readonly since: number;
}

/** Why a turn was ended as stalled: its provider exited with no word, or did not answer when asked. */
export type StalledReason = 'dead' | 'unresponsive';

export interface StalledTurn {
    readonly reason: StalledReason;
    /** How long the turn had sent nothing when it was ended. */
    readonly silentMs: number;
    /** Epoch ms: when it was ended. */
    readonly at: number;
}

/** What a liveness check found: `unknown` = Genie had no way to ask, never a guess either way. */
export type Liveness = 'alive' | 'dead' | 'unresponsive' | 'unknown';

const MIN = 60_000;

/** Minutes, rounded down, never 0 once a minute has passed: `21 min`; under one, `under a minute`. */
export function minutesWords(ms: number): string {
    const m = Math.floor(ms / MIN);
    return m < 1 ? 'under a minute' : `${m} min`;
}

/** A command's first line, cut to fit a header. */
export function commandLine(command: string | null): string | null {
    if (command === null) return null;
    const line = command.split('\n').map((l) => l.trim()).find((l) => l.length > 0) ?? '';
    if (line.length === 0) return null;
    return line.length > 120 ? `${line.slice(0, 119)}…` : line;
}

/** `Bash · git push origin feat/x · 21 min`: the agent view's line for the call it is in. */
export function runningCallWords(call: RunningCall, now: number): string {
    const command = commandLine(call.command);
    return [call.label, ...(command ? [command] : []), minutesWords(now - call.since)].join(' · ');
}

/** The silence notice (core/turn-stall.ts): what is silent, and — when a call is running — which call and since when. */
export function stallNoticeText(silentMs: number, call: RunningCall | null, now: number): string {
    const minutes = Math.round(silentMs / MIN);
    if (call === null) {
        return `This turn has produced no output for ${minutes} minutes, and no tool call is running. Genie is checking whether the provider is still there; Stop the turn to send a new message.`;
    }
    const command = commandLine(call.command);
    return `This turn has produced no output for ${minutes} minutes. It is in ${call.label}${command ? `: \`${command}\`` : ''} (started ${minutesWords(now - call.since)} ago). Stop this call ends just that call and the agent carries on; Stop the turn ends the turn.`;
}

/** `Stalled · no events for 34 min`: the pill and the chat line, never Working. */
export function stalledWords(stalled: StalledTurn): string {
    return `Stalled · no events for ${minutesWords(stalled.silentMs)}`;
}

/** What the chat says when Genie ends a turn as stalled. */
export function stalledNotice(stalled: Pick<StalledTurn, 'reason' | 'silentMs'>): string {
    const why = stalled.reason === 'dead'
        ? 'its provider process is no longer running'
        : 'its provider did not answer when Genie asked';
    return `Genie ended this turn as stalled: no events for ${minutesWords(stalled.silentMs)}, and ${why}. Restart starts the agent again on the same conversation; your next message does too.`;
}

/** What the agent is told when one of its calls is ended (Stop this call, or the no-output timeout). */
export function callEndedText(call: RunningCall, cause: 'you' | 'timeout', now: number): string {
    const command = commandLine(call.command);
    const what = `${call.label}${command ? ` \`${command}\`` : ''}`;
    const why = cause === 'you'
        ? `the person stopped it after ${minutesWords(now - call.since)}`
        : `it had produced no output for ${minutesWords(now - call.since)} (Genie's no-output timeout for a tool call)`;
    return `Genie ended your tool call ${what}: ${why}. It did not finish, so do not rely on its result. If you still need it, run it again with a timeout or in the background, or say what it is waiting on.`;
}

/** The chat's own line for it. */
export function callEndedNotice(call: RunningCall, cause: 'you' | 'timeout', ended: number, now: number): string {
    const command = commandLine(call.command);
    return `${cause === 'you' ? 'You stopped' : 'Genie’s no-output timeout ended'} ${call.label}${command ? ` \`${command}\`` : ''} after ${minutesWords(now - call.since)} (${ended} process${ended === 1 ? '' : 'es'} ended). The agent was told and its turn goes on.`;
}

/**
 * THE PROCESSES A CALL STARTED: below the run's roots (its provider), started at or after the call began (with a second
 * of slack for clocks that read start times coarsely), the roots themselves never. What ran before the call — the MCP
 * servers the session came up with, a background task started earlier — is not the call's and is never in the answer.
 */
export function callProcesses(table: readonly ProcessInfo[], roots: readonly ProcessInfo[], since: number): ProcessInfo[] {
    const rootPids = new Set(roots.map((r) => r.pid));
    const below = new Set<number>();
    let grew = true;
    while (grew) {
        grew = false;
        for (const p of table) {
            if (below.has(p.pid) || rootPids.has(p.pid)) continue;
            if (rootPids.has(p.ppid) || below.has(p.ppid)) { below.add(p.pid); grew = true; }
        }
    }
    const from = since - 1_000;
    return table.filter((p) => below.has(p.pid) && p.started >= from);
}

/** The setting `tool_call_timeout_minutes` as milliseconds: 0 = never; anything unreadable = the default. */
export const DEFAULT_TOOL_TIMEOUT_MINUTES = 15;
const TOOL_TIMEOUT_OPTIONS = [0, 5, 10, 15, 20, 30, 60];
export function toolTimeoutMsFrom(values: Readonly<Record<string, unknown>>): number {
    const raw = values.tool_call_timeout_minutes;
    const n = raw === undefined || raw === null || raw === '' ? Number.NaN : Number(raw);
    return (TOOL_TIMEOUT_OPTIONS.includes(n) ? n : DEFAULT_TOOL_TIMEOUT_MINUTES) * MIN;
}

/** The setting `stalled_auto_restart`: restart an agent whose turn was ended as stalled. Off unless set. */
export function stalledAutoRestartFrom(values: Readonly<Record<string, unknown>>): boolean {
    return values.stalled_auto_restart === true || values.stalled_auto_restart === 'true';
}

export const STALLED_DECK_PREFIX = 'stalled:';

export interface StalledRecord {
    readonly agentId: string;
    readonly agentName: string;
    readonly workspaceId: string | null;
    readonly reason: StalledReason;
    readonly silentMs: number;
    readonly at: number;
}

/**
 * THE DECK'S STALLED TURNS: one item per agent, with Stop, Restart and Dismiss. Kept in genie-host's memory: a stalled
 * turn belongs to the run it happened in, and a restart of the host restarts that run anyway.
 */
export class StalledTurnBook {
    readonly #items = new Map<string, StalledRecord>();
    readonly #listeners = new Set<() => void>();

    record(entry: StalledRecord): void {
        this.#items.set(entry.agentId, entry);
        this.#changed();
    }

    /** Its item is gone (answered, dismissed, or the agent moved on). `false` when there was none. */
    clear(agentId: string): boolean {
        const gone = this.#items.delete(agentId);
        if (gone) this.#changed();
        return gone;
    }

    has(agentId: string): boolean {
        return this.#items.has(agentId);
    }

    items(): DeckItem[] {
        return [...this.#items.values()].map((s) => ({
            id: `${STALLED_DECK_PREFIX}${s.agentId}`,
            source: 'genie',
            agentId: s.agentId,
            agentName: s.agentName,
            workspaceId: s.workspaceId,
            title: `${s.agentName}’s turn stalled: no events for ${minutesWords(s.silentMs)}`,
            blocking: true,
            priority: 'high',
            at: s.at,
            answer: { kind: 'inline', options: [{ id: 'stop', label: 'Stop', tone: 'neutral' }, { id: 'restart', label: 'Restart', tone: 'neutral' }, { id: 'dismiss', label: 'Dismiss', tone: 'neutral' }] },
            forwardedFrom: null,
            detail: stalledNotice(s),
        }));
    }

    onChange(listener: () => void): () => void {
        this.#listeners.add(listener);
        return () => { this.#listeners.delete(listener); };
    }

    #changed(): void {
        for (const l of this.#listeners) l();
    }
}

/**
 * A CALL THAT HAS GONE SILENT (Tynn #950): the agent view shows it IN THE STREAM, at the call's own entry, never in the
 * header (the owner on beta.65: "I don't need to see the workstream in the freaking header"). Silent = nothing from the
 * provider since the later of the call's start and its last event, for SILENT_CALL_MS. #855's no-output timeout (15 min,
 * `tool_call_timeout_minutes`) still ends it; this only says, well before that, that it is quiet.
 */
export const SILENT_CALL_MS = 2 * MIN;

export interface SilentCall {
    readonly toolCallId: string;
    /** Its name, as the call reports it (`Bash`): never its command, which is on its own row already. */
    readonly label: string;
    readonly silentMs: number;
}

export function silentCall(call: RunningCall | null | undefined, lastEventAt: number | null | undefined, now: number): SilentCall | null {
    if (!call) return null;
    const from = typeof lastEventAt === 'number' ? Math.max(call.since, lastEventAt) : call.since;
    const silentMs = now - from;
    return silentMs >= SILENT_CALL_MS ? { toolCallId: call.toolCallId, label: call.label, silentMs } : null;
}

/** `No output for 3 min`. */
export function silentCallWords(silent: SilentCall): string {
    return `No output for ${minutesWords(silent.silentMs)}`;
}
