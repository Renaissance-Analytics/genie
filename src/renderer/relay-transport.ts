import type { ClientTransport } from '../core/remote-protocol.js';
import type { ShareLink } from '../main/tynn-share-links.js';

/**
 * A TYNN WORKSTATION'S CONNECTION, SEEN FROM THE WINDOW (Tynn #837). Main dials the relay with the Tynn grant and the
 * proof key — neither ever reaches the renderer — and gives the window a CHANNEL; Genie's protocol crosses IPC on it.
 */

export interface TynnWorkstationRow {
    readonly id: string;
    readonly name: string;
    readonly active: boolean;
    readonly connectable: boolean;
    readonly local: boolean;
    readonly source: string | null;
}

export type TynnWorkstationList = { readonly ok: true; readonly workstations: readonly TynnWorkstationRow[] } | { readonly ok: false; readonly reason: string };

/** What preload exposes (main/preload.ts `tynnNetwork`). */
export interface TynnNetworkBridge {
    /** The workstations Tynn says this person can see, never this machine. */
    workstations(): Promise<TynnWorkstationList>;
    /** Main mints a grant and dials the relay; the channel is this connection's. */
    open(workstationId: string): Promise<{ ok: true; channel: string } | { ok: false; reason: string }>;
    send(channel: string, text: string): void;
    close(channel: string): void;
    onMessage(listener: (channel: string, text: string) => void): () => void;
    onClosed(listener: (channel: string, reason: string | null) => void): () => void;
    /** Sharing this machine through Tynn (Tynn #839): `workspaceId: null` = the whole workstation. */
    shares?: {
        list(workspaceId: string | null): Promise<{ ok: true; links: ShareLink[] } | { ok: false; reason: string }>;
        mint(input: { workspaceId: string | null; capability: 'control' | 'readonly'; expiresInDays: number }): Promise<{ ok: true; link: ShareLink } | { ok: false; reason: string }>;
        revoke(linkId: string): Promise<{ ok: true } | { ok: false; reason: string }>;
    };
}

export interface RelayClientTransport extends ClientTransport {
    /** Why main closed it (the relay's or the host's words); `null` while open or after our own close. */
    closedBecause(): string | null;
}

export function ipcRelayTransport(net: TynnNetworkBridge, channel: string): RelayClientTransport {
    const messages = new Set<(text: string) => void>();
    const closes = new Set<() => void>();
    let closed = false;
    let because: string | null = null;
    const offMessage = net.onMessage((c, text) => { if (c === channel && !closed) for (const l of messages) l(text); });
    const offClosed = net.onClosed((c, reason) => {
        if (c !== channel || closed) return;
        closed = true;
        because = reason;
        offMessage();
        offClosed();
        for (const l of closes) l();
    });
    return {
        send: (text) => { if (!closed) net.send(channel, text); },
        onMessage: (l) => { messages.add(l); return () => { messages.delete(l); }; },
        onClose: (l) => { closes.add(l); return () => { closes.delete(l); }; },
        close: () => {
            if (closed) return;
            closed = true;
            offMessage();
            offClosed();
            net.close(channel);
            for (const l of closes) l();
        },
        closedBecause: () => because,
    };
}

/**
 * CONNECT'S TYNN WORKSTATIONS FOLLOW THE SIGN-IN (Tynn #850): `onChange` with this Genie's Tynn sign-in at once and
 * each time it CHANGES — not on every features push, and not while features are unread (`integrations: null` is not
 * "signed out"). The list is read again on each.
 */
export function watchTynnSignIn(
    features: { snapshot(): Promise<import('./features.js').FeatureData>; subscribe(listener: (data: import('./features.js').FeatureData) => void): () => void },
    onChange: (signedIn: boolean) => void,
): () => void {
    let last: boolean | null = null;
    let stopped = false;
    const see = (data: import('./features.js').FeatureData) => {
        if (stopped || !data.integrations) return;
        const signedIn = data.integrations.tynnSignedIn;
        if (signedIn === last) return;
        last = signedIn;
        onChange(signedIn);
    };
    const off = features.subscribe(see);
    void features.snapshot().then(see, () => {});
    return () => { stopped = true; off(); };
}
