/** Sleeping is display-only, five minutes after a running agent becomes Idle (after Cooling). */
export const SLEEPING_AFTER_IDLE_MS = 5 * 60_000;

/** One display predicate for the board, header and chat. It never decides whether work can be sent. */
export function isSleeping(session: { running: boolean; turnState: string; cooling?: boolean | undefined; idleSince?: number | null | undefined; background?: number | null | undefined; stoppedByYou?: boolean | undefined; starting?: boolean | undefined }, now: number): boolean {
    return session.running && session.turnState === 'idle' && !session.cooling && !session.starting && !session.stoppedByYou
        && (session.background ?? 0) === 0 && session.idleSince != null && now - session.idleSince >= SLEEPING_AFTER_IDLE_MS;
}
