import type { SiteOpen } from './relay-site.js';

/**
 * ONE DOOR PER WORKSTATION CONNECTION (browser rebuild step 4). The Genie browser's session for another workstation is
 * routed to a loopback door (relay-site.ts `siteDoor`) that opens `site` streams on THAT window's relay connection. The
 * door lives as long as the connection: it closes with it, and a reconnect gets a new one (a new port, which the
 * session is re-routed to). The host's CA arrives with the host's answer to an open, over the authenticated session;
 * it is what that connection's browser trusts, and nothing else is.
 */

/** What a door needs from a relay connection. */
export interface SiteTransport {
    openSite(host: string): Promise<SiteOpen>;
    onClose(listener: () => void): () => void;
}

export type MakeDoor = (input: { allowed(host: string): boolean; open(host: string): Promise<SiteOpen> }) => Promise<{ port: number; close(): void }>;

/** A connection's browsing: the door's port now, and the host's CA as last answered (`null` before any open). */
export interface RemoteVia {
    port(): number;
    ca(): string | null;
}

interface Entry {
    readonly transport: SiteTransport;
    readonly door: Promise<{ port: number; close(): void }>;
    /** The door once made; closed at once on a drop, or as soon as it is made. */
    made: { port: number; close(): void } | null;
    port: number;
    ca: string | null;
    readonly off: () => void;
}

export class RemoteBrowsers {
    readonly #makeDoor: MakeDoor;
    readonly #by = new Map<string, Entry>();

    constructor(makeDoor: MakeDoor) {
        this.#makeDoor = makeDoor;
    }

    async connect(workstationId: string, transport: SiteTransport): Promise<RemoteVia> {
        let entry = this.#by.get(workstationId);
        if (entry && entry.transport !== transport) {
            this.#drop(workstationId, entry);
            entry = undefined;
        }
        if (!entry) {
            const fresh: Entry = {
                transport,
                made: null,
                port: 0,
                ca: null,
                // Any `.gen` name may be asked for: the HOST decides what it serves, and says so when it does not.
                door: this.#makeDoor({
                    allowed: () => true,
                    open: async (host) => {
                        const opened = await transport.openSite(host);
                        if (opened.ok && opened.ca !== undefined && this.#by.get(workstationId) === fresh) fresh.ca = opened.ca;
                        return opened;
                    },
                }),
                off: transport.onClose(() => { if (this.#by.get(workstationId) === fresh) this.#drop(workstationId, fresh); }),
            };
            this.#by.set(workstationId, fresh);
            entry = fresh;
        }
        const live = entry;
        const door = await live.door;
        live.made = door;
        live.port = door.port;
        return { port: () => live.port, ca: () => live.ca };
    }

    #drop(workstationId: string, entry: Entry): void {
        this.#by.delete(workstationId);
        entry.off();
        if (entry.made) entry.made.close();
        else void entry.door.then((d) => d.close(), () => {});
    }
}
