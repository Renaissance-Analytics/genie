/**
 * GENIE-HOST'S FRONT DOOR, AS MAIN'S OWN CLIENT WATCHES IT (Tynn #1046, client/host split step 2g-4d-D1). The front door is
 * genie-host's (P5a): its port, Genie's CA for the .gen hosts (or why there is none), the routes it serves, and which
 * workspace each site is in. main's browser sessions, its site panels, its cookie bridge, its GApp windows and the facts
 * its browser is told all read these, so main keeps ONE view that genie-host says on `frontdoor.watch` / `local-frontdoor`,
 * to main's own client only, and again whenever it changes. It replaces main's reads of compose's hosting replica.
 */
export interface FrontDoorRoute {
    readonly host: string;
    /** Where the front door sends the host: `127.0.0.1:<port>` (gen-router.ts GenRoute). */
    readonly target: string;
}

export interface FrontDoorSite {
    readonly host: string;
    readonly name: string;
    readonly workspaceId: string;
}

export interface FrontDoorWatchView {
    /** The front door's port; 0 = none (yet). */
    readonly port: number;
    /** Genie's CA, which the browser sessions trust for .gen hosts only; null = none, and `caReason` says why. */
    readonly caPem: string | null;
    readonly caReason: string | null;
    readonly routes: readonly FrontDoorRoute[];
    readonly sites: readonly FrontDoorSite[];
}

export const EMPTY_FRONT_DOOR_WATCH: FrontDoorWatchView = Object.freeze({
    port: 0, caPem: null, caReason: 'genie-host has not said its front door yet', routes: Object.freeze([]) as readonly FrontDoorRoute[], sites: Object.freeze([]) as readonly FrontDoorSite[],
});

const NO_HOSTING = 'this host runs no front door';
const rec = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): v is string => typeof v === 'string';

/** What came over the wire; anything that does not read is no front door yet. */
export function readFrontDoorWatch(raw: unknown): FrontDoorWatchView {
    if (!rec(raw) || typeof raw.port !== 'number' || !Number.isInteger(raw.port) || raw.port < 0) return EMPTY_FRONT_DOOR_WATCH;
    if (raw.caPem !== null && !str(raw.caPem)) return EMPTY_FRONT_DOOR_WATCH;
    if (raw.caReason !== null && !str(raw.caReason)) return EMPTY_FRONT_DOOR_WATCH;
    if (!Array.isArray(raw.routes) || !raw.routes.every((r) => rec(r) && str(r.host) && str(r.target))) return EMPTY_FRONT_DOOR_WATCH;
    if (!Array.isArray(raw.sites) || !raw.sites.every((s) => rec(s) && str(s.host) && str(s.name) && str(s.workspaceId))) return EMPTY_FRONT_DOOR_WATCH;
    return {
        port: raw.port,
        caPem: raw.caPem as string | null,
        caReason: raw.caReason as string | null,
        routes: (raw.routes as Record<string, string>[]).map((r) => ({ host: r.host!, target: r.target! })),
        sites: (raw.sites as Record<string, string>[]).map((s) => ({ host: s.host!, name: s.name!, workspaceId: s.workspaceId! })),
    };
}

/** genie-host's hosting, as much of it as the view reads (hosting-compose.ts HostingStack). */
export interface FrontDoorHosting {
    readonly frontDoorPort: number;
    browserTrust(): { readonly caPem: string } | { readonly caPem: null; readonly reason: string };
    routes(): readonly FrontDoorRoute[];
    readonly sites: { list(): readonly { readonly host: string; readonly name: string; readonly workspaceId: string }[] };
}

/** The view of genie-host's hosting now; no hosting is no front door. */
export function frontDoorViewOf(stack: FrontDoorHosting | null): FrontDoorWatchView {
    if (!stack) return { ...EMPTY_FRONT_DOOR_WATCH, caReason: NO_HOSTING };
    const trust = stack.browserTrust();
    return {
        port: stack.frontDoorPort,
        caPem: trust.caPem,
        caReason: trust.caPem === null ? (trust as { reason: string }).reason : null,
        routes: stack.routes().map((r) => ({ host: r.host, target: r.target })),
        sites: stack.sites.list().map((s) => ({ host: s.host, name: s.name, workspaceId: s.workspaceId })),
    };
}

/** genie-host's front door as a feed: the view now, then again only when it changed (its sources fire for more than it holds). */
export function frontDoorWatchFeed(ports: { read(): FrontDoorWatchView; onChange(listener: () => void): () => void }): { now(): FrontDoorWatchView; subscribe(listener: (view: FrontDoorWatchView) => void): () => void } {
    const listeners = new Set<(view: FrontDoorWatchView) => void>();
    let said = JSON.stringify(ports.read());
    ports.onChange(() => {
        const view = ports.read();
        const key = JSON.stringify(view);
        if (key === said) return;
        said = key;
        for (const l of [...listeners]) l(view);
    });
    return {
        // A read only: a new watcher's answer never swallows the change the others are owed.
        now: () => ports.read(),
        subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    };
}
