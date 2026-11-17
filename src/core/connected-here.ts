/**
 * SOMEONE IS CONNECTED TO THIS MACHINE (Tynn #726, critical; the owner's live trial, 2026-11-16). A Pilot reached a
 * client's Genie over the relay and the client saw nothing. genie-host always knew (RemoteHost.connections(), on every
 * window as `features.remote.connections`); only Settings → Remote access read it. This is what the client's windows say
 * while anyone is connected (ConnectedHereBanner), and what main notifies on each arrival.
 *
 * A person is a LABEL: a Pilot's Take Over window is a second connection under the same label, and is one person.
 */

export interface HereConnection {
    readonly id: string;
    readonly label: string;
    readonly driving: boolean;
}

export interface ConnectedHere {
    /** Each person connected, once, in the order they appear. */
    readonly labels: readonly string[];
    /** Who holds the baton; `null` = nobody drives. */
    readonly driver: string | null;
}

/** Who is connected now; `null` = nobody. */
export function connectedHere(connections: readonly HereConnection[]): ConnectedHere | null {
    if (connections.length === 0) return null;
    const labels: string[] = [];
    for (const c of connections) if (!labels.includes(c.label)) labels.push(c.label);
    return { labels, driver: connections.find((c) => c.driving)?.label ?? null };
}

function names(labels: readonly string[]): string {
    if (labels.length <= 1) return labels[0] ?? '';
    return `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`;
}

/** The banner's words: who, and who drives. */
export function connectedWords(here: ConnectedHere): string {
    const who = `${names(here.labels)} ${here.labels.length === 1 ? 'is' : 'are'} connected`;
    if (here.driver === null) return who;
    return here.labels.length === 1 && here.labels[0] === here.driver ? `${who} · driving` : `${who} · ${here.driver} driving`;
}

/** The desktop notification for one arrival. */
export function connectNotice(label: string, hostName: string): { title: string; body: string } {
    return { title: `${label} connected to ${hostName}`, body: 'They can see and use this machine. Lock or manage it in Genie.' };
}

/**
 * Each ARRIVAL, once: a person (label) not connected at the last look. Their second window, a status redraw and a drop
 * report nothing; leaving and coming back reports them again. The first look reports whoever is already connected.
 */
export class ConnectWatch {
    #present = new Set<string>();

    next(connections: readonly HereConnection[]): string[] {
        const now = new Set(connections.map((c) => c.label));
        const arrived = [...now].filter((label) => !this.#present.has(label));
        this.#present = now;
        return arrived;
    }
}
