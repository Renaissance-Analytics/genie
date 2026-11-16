/**
 * THE DASHBOARD'S COMMS, FROM AGENTINBOX (§4.1). Who a declared agent exchanged mail with since its session started
 * — agents only, the human is not a collaborator — with each link's message count and the age of its newest
 * message. `collaborators` is the number of links; `commsAgeSeconds` the newest link's age, or `null` with none.
 * A running declared agent with no traffic is `0`, a measured fact; an agent nobody measured stays `null` upstream.
 */
export interface CommsLink {
    /** The peer agent's id — the row the collaborator reveal draws a lane to. */
    readonly peer: string;
    readonly count: number;
    readonly ageSeconds: number;
    /** Who sent the newest message: this agent (`self`) or the peer. Absent = not measured (read as `self`). */
    readonly lastFrom?: 'self' | 'peer' | undefined;
    /** The newest message is not yet read by its recipient. */
    readonly unread?: boolean | undefined;
    /** The newest message was read but has gone `WAITING_AFTER_SECONDS` without an answer. */
    readonly waiting?: boolean | undefined;
}

/** A read, unanswered message is "waiting on a reply" once it is this old. */
export const WAITING_AFTER_SECONDS = 60;

export interface Comms {
    readonly collaborators: number;
    readonly commsAgeSeconds: number | null;
    /** Newest first. */
    readonly links: readonly CommsLink[];
}

export type CommsMail = readonly { readonly from: string; readonly to: string; readonly sentAt: string; readonly readAt?: string | null | undefined }[];

/** Each peer's count and newest message time: everything comms needs from the mail, and nothing that depends on `now`. */
export type CommsTally = ReadonlyMap<string, { readonly count: number; readonly last: number; readonly lastFrom: 'self' | 'peer'; readonly lastRead: boolean }>;

/** The scan: one pass over the agent's mail since its session started. The expensive half of `commsOf`. */
export function commsTally(mail: CommsMail, agentId: string, since: number): CommsTally {
    const byPeer = new Map<string, { count: number; last: number; lastFrom: 'self' | 'peer'; lastRead: boolean }>();
    for (const m of mail) {
        const peer = m.from === agentId ? m.to : m.to === agentId ? m.from : null;
        if (peer === null || peer === 'human' || peer === agentId) continue;
        const t = Date.parse(m.sentAt);
        if (!(t >= since)) continue;
        const link = byPeer.get(peer);
        const newest = !link || t >= link.last;
        byPeer.set(peer, {
            count: (link?.count ?? 0) + 1,
            last: newest ? t : link.last,
            lastFrom: newest ? (m.from === agentId ? 'self' : 'peer') : link.lastFrom,
            lastRead: newest ? m.readAt !== null && m.readAt !== undefined : link.lastRead,
        });
    }
    return byPeer;
}

/** The cheap half: ages against `now`, one step per peer. */
export function commsAt(tally: CommsTally, now: number): Comms {
    const links = [...tally].map(([peer, l]) => {
        const ageSeconds = Math.max(0, Math.floor((now - l.last) / 1000));
        return { peer, count: l.count, ageSeconds, lastFrom: l.lastFrom, unread: !l.lastRead, waiting: l.lastRead && ageSeconds >= WAITING_AFTER_SECONDS };
    }).sort((a, b) => a.ageSeconds - b.ageSeconds);
    return { collaborators: links.length, commsAgeSeconds: links[0]?.ageSeconds ?? null, links };
}

export function commsOf(mail: CommsMail, agentId: string, since: number, now: number): Comms {
    return commsAt(commsTally(mail, agentId, since), now);
}

/**
 * THE DASHBOARD'S COMMS, READ PER PROBE (beta.59: 1-2 s window-main stalls in `commsOf`). `mailOf` is the agent's mail
 * (the inbox's `involving`, bounded); `tally` is the scan, injectable so a test can count it.
 *
 * SCANNED ONCE PER CHANGE: the tally is kept per agent and reused while `mailOf` returns the SAME array and `since`
 * is the same. `involving` keeps an agent's array until that agent's mail changes (core/inbox-read.ts), so mail for
 * another agent, or another agent reading its mail, scans nothing here. Ages are worked out against `now` per read.
 */
export class CommsCache {
    readonly #mailOf: (agentId: string) => CommsMail | null;
    readonly #tally: typeof commsTally;
    readonly #kept = new Map<string, { readonly mail: CommsMail; readonly since: number; readonly tally: CommsTally }>();

    constructor(mailOf: (agentId: string) => CommsMail | null, tally: typeof commsTally = commsTally) {
        this.#mailOf = mailOf;
        this.#tally = tally;
    }

    read(agentId: string, since: number, now: number): Comms | null {
        const mail = this.#mailOf(agentId);
        if (mail === null) return null;
        const kept = this.#kept.get(agentId);
        if (kept && kept.mail === mail && kept.since === since) return commsAt(kept.tally, now);
        const tally = this.#tally(mail, agentId, since);
        // Bounded like the involving cache: one entry per agent, cleared if it ever grows past any real roster.
        if (!kept && this.#kept.size > 2000) this.#kept.clear();
        this.#kept.set(agentId, { mail, since, tally });
        return commsAt(tally, now);
    }
}
