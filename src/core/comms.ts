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
}

export interface Comms {
    readonly collaborators: number;
    readonly commsAgeSeconds: number | null;
    /** Newest first. */
    readonly links: readonly CommsLink[];
}

export function commsOf(mail: readonly { readonly from: string; readonly to: string; readonly sentAt: string }[], agentId: string, since: number, now: number): Comms {
    const byPeer = new Map<string, { count: number; last: number }>();
    for (const m of mail) {
        const peer = m.from === agentId ? m.to : m.to === agentId ? m.from : null;
        if (peer === null || peer === 'human' || peer === agentId) continue;
        const t = Date.parse(m.sentAt);
        if (!(t >= since)) continue;
        const link = byPeer.get(peer) ?? { count: 0, last: t };
        byPeer.set(peer, { count: link.count + 1, last: Math.max(link.last, t) });
    }
    const links = [...byPeer].map(([peer, l]) => ({ peer, count: l.count, ageSeconds: Math.max(0, Math.floor((now - l.last) / 1000)) })).sort((a, b) => a.ageSeconds - b.ageSeconds);
    return { collaborators: links.length, commsAgeSeconds: links[0]?.ageSeconds ?? null, links };
}
