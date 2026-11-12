import type { DeviceTokens } from './device-tokens.js';
import { relayWorkstationOf } from '../core/remote-window.js';
import type { PopKeypair, RelayMemberResult, RelayMemberTransport } from './relay-member.js';
import type { PopJwk } from './relay-wire.js';
import type { RemoteBrowsers, RemoteVia } from './remote-browsers.js';
import type { mintConnectGrant } from './tynn-network.js';

/**
 * ANOTHER MACHINE'S SOCKET IS THE HOST'S (P3.4 cut e, audit M-e). A window speaks Genie's protocol on a channel, as it does over the relay, and the token never reaches it:
 *
 * - Its first frame must be a hello saying `pin` or `saved`. A saved hello is sent with the token the keychain holds. Nothing else may go first.
 * - Until the machine's welcome, frames are read. The welcome's minted token is kept here and cut from the frame, and what follows waits behind it, so a window that hears
 *   "connected" finds the host already listed as paired.
 * - After the welcome the host only carries frames, and reads none.
 *
 * A token goes only to the url it was minted by: it is found by that url and nothing else.
 */
export interface DeviceSocket {
    readyState: number;
    onopen: ((ev: unknown) => void) | null;
    onmessage: ((ev: { data: unknown }) => void) | null;
    onclose: ((ev: unknown) => void) | null;
    onerror: ((ev: unknown) => void) | null;
    send(data: string): void;
    close(): void;
}

export type DeviceLinkEvent =
    | { readonly type: 'frame'; readonly channel: string; readonly text: string }
    | { readonly type: 'closed'; readonly channel: string; readonly reason: string | null }
    /** A relay connection's progress: Tynn gave the way in, the relay to the machine is next (Tynn #552). */
    | { readonly type: 'step'; readonly workstationId: string; readonly step: 'relay' }
    /** The browser's door to a relay channel's workstation moved, or learned that host's CA (Tynn #552). */
    | { readonly type: 'via'; readonly channel: string; readonly port: number; readonly ca: string | null };

/** Tynn's answer to a connect grant (tynn-network.ts `mintConnectGrant`). */
export type ConnectGrant = Awaited<ReturnType<typeof mintConnectGrant>>;

/**
 * A PILOT'S CONNECTION TO ANOTHER WORKSTATION (Tynn #552, host split P5d.4; audit M-e): genie-host mints the grant with its
 * own Tynn account, holds the proof key, opens the relay member and renews its grant. The window gets a channel.
 */
export interface RelayMemberPorts {
    readonly signedIn: () => boolean;
    /** Why this machine may not connect out (a drone, from the role genie-host read from Tynn); `null` = it may. */
    readonly refusal?: () => string | null | Promise<string | null>;
    readonly keypair: () => PopKeypair;
    readonly mint: (workstationId: string, jwk: PopJwk) => Promise<ConnectGrant>;
    readonly open: (input: { relayUrl: string; workstationId: string; grant: string; pop: PopKeypair; renew: () => Promise<ConnectGrant> }) => Promise<RelayMemberResult>;
}

/** What a window is told when its relay connection could not open: where, and Tynn's own refusal for it to word. */
export type RelayOpened =
    | { readonly ok: true; readonly channel: string }
    | { readonly ok: false; readonly reason: string; readonly stage?: 'relay' }
    | { readonly ok: false; readonly stage: 'tynn'; readonly refusal: Extract<ConnectGrant, { ok: false }> };

export type DeviceLinkOpened = { readonly ok: true; readonly channel: string } | { readonly ok: false; readonly reason: string };

export interface DeviceLinkServiceOptions {
    readonly tokens: DeviceTokens;
    readonly socket: (url: string) => DeviceSocket;
    readonly send: (owner: string, event: DeviceLinkEvent) => void;
    readonly log: (line: string) => void;
    readonly dialTimeoutMs?: number;
    /** Relay connections to Tynn workstations (Tynn #552); absent = none open here. */
    readonly relay?: RelayMemberPorts;
    /** The browser's doors to those workstations' `.gen` sites (remote-browsers.ts). */
    readonly browsers?: RemoteBrowsers;
}

interface RelayChannel {
    readonly id: string;
    readonly owner: string;
    readonly workstationId: string;
    readonly transport: RelayMemberTransport;
    via: RemoteVia | null;
    closed: boolean;
}

export const isDeviceUrl = (url: unknown): url is string => typeof url === 'string' && /^wss?:\/\/./i.test(url);

/** A frame, read only as far as this file needs: the machine's protocol is between it and the window, whatever version either speaks. */
function frameOf(text: string): Record<string, unknown> | null {
    try {
        const parsed: unknown = JSON.parse(text);
        return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
    } catch {
        return null;
    }
}

/** The largest frame the host takes from another machine in one piece. */
export const DEVICE_FRAME_LIMIT_BYTES = 100 * 1024 * 1024;
const TOO_LARGE = `That machine sent a message larger than ${DEVICE_FRAME_LIMIT_BYTES / (1024 * 1024)} MiB, the most this connection carries in one piece, so the connection was closed. It usually means an agent's history there has grown very long.`;
const TOO_LARGE_THERE = 'That machine closed the connection because a message from this one was too large for it.';

/** The words for a socket's error: its own, unless it is the frame limit, which a person should be able to read. */
function errorWords(ev: unknown): string | null {
    const e = ev as { message?: unknown; error?: { code?: unknown } } | null;
    if (e?.error?.code === 'WS_ERR_UNSUPPORTED_MESSAGE_LENGTH' || (typeof e?.message === 'string' && /max payload/i.test(e.message))) return TOO_LARGE;
    return typeof e?.message === 'string' && e.message.length > 0 ? `The connection to that machine failed: ${e.message}` : null;
}
const DEFAULT_DIAL_TIMEOUT_MS = 20_000;
const PIN_NEEDED = 'type the PIN shown on that machine — this device has not paired with it yet';

interface Channel {
    readonly id: string;
    readonly owner: string;
    readonly url: string;
    readonly socket: DeviceSocket;
    /** Nothing has gone out yet: the next frame must be the hello. */
    hello: 'waiting' | 'reading-keychain' | 'sent';
    /** Frames from the window, held while the keychain is read. */
    readonly outbound: string[];
    welcomed: boolean;
    /** Frames from the machine, held while the keychain writes a minted token. */
    inbound: string[] | null;
    closed: boolean;
}

export class DeviceLinkService {
    readonly #options: DeviceLinkServiceOptions;
    readonly #channels = new Map<string, Channel>();
    readonly #relays = new Map<string, RelayChannel>();
    #next = 0;
    #nextRelay = 0;

    constructor(options: DeviceLinkServiceOptions) {
        this.#options = options;
        // The door learned a host's CA (or moved): each window browsing through it is told, so its browser trusts that CA.
        options.browsers?.onChange((workstationId) => {
            for (const r of this.#relays.values()) {
                if (r.workstationId !== workstationId || r.via === null || r.closed) continue;
                this.#options.send(r.owner, { type: 'via', channel: r.id, port: r.via.port(), ca: r.via.ca() });
            }
        });
    }

    /** A relay connection to a Tynn workstation, for a window (Tynn #552): the grant and the key stay here. */
    async openRelay(owner: string, workstationId: string): Promise<RelayOpened> {
        const relay = this.#options.relay;
        if (!relay) return { ok: false, reason: 'this Genie connects to no Tynn workstations' };
        if (typeof workstationId !== 'string' || workstationId.length === 0 || relayWorkstationOf(`relay:${workstationId}`) === null) return { ok: false, reason: 'not a Tynn workstation' };
        const refused = (await relay.refusal?.()) ?? null;
        if (refused) return { ok: false, reason: refused };
        if (!relay.signedIn()) return { ok: false, reason: 'sign in to Tynn to connect to a Tynn workstation' };
        const pop = relay.keypair();
        // Each step is said where it fails (core/relay-connect.ts): Tynn's way in, then the relay to the machine.
        const grant = await relay.mint(workstationId, pop.publicJwk);
        if (!grant.ok) return { ok: false, stage: 'tynn', refusal: grant };
        this.#options.send(owner, { type: 'step', workstationId, step: 'relay' });
        // A fresh grant for the SAME key before each one expires (genie#1401): the session lasts while the window stays.
        const renew = (): Promise<ConnectGrant> => (relay.signedIn() ? relay.mint(workstationId, pop.publicJwk) : Promise.resolve({ ok: false, reason: 'signed out of Tynn' }));
        const opened = await relay.open({ relayUrl: grant.relayEndpoint, workstationId, grant: grant.token, pop, renew });
        if (!opened.ok) return { ok: false, stage: 'relay', reason: opened.reason };
        const id = `relay_${++this.#nextRelay}`;
        const channel: RelayChannel = { id, owner, workstationId, transport: opened.transport, via: null, closed: false };
        this.#relays.set(id, channel);
        opened.transport.onMessage((text) => { if (!channel.closed) this.#options.send(owner, { type: 'frame', channel: id, text }); });
        opened.transport.onClose(() => {
            if (channel.closed) return;
            channel.closed = true;
            this.#relays.delete(id);
            this.#options.send(owner, { type: 'closed', channel: id, reason: opened.transport.closedBecause() });
        });
        return { ok: true, channel: id };
    }

    /** The browser's door to a relay channel's workstation: its port and that host's CA, as now (Tynn #552). */
    async browserVia(owner: string, id: string): Promise<{ ok: true; port: number; ca: string | null } | { ok: false; reason: string }> {
        const r = this.#relays.get(id);
        if (!r || r.owner !== owner || r.closed) return { ok: false, reason: 'This window is not connected to its workstation right now. Reconnect, then open the browser again.' };
        if (!this.#options.browsers) return { ok: false, reason: 'this Genie opens no browser doors' };
        r.via = await this.#options.browsers.connect(r.workstationId, r.transport);
        return { ok: true, port: r.via.port(), ca: r.via.ca() };
    }

    open(owner: string, url: string): Promise<DeviceLinkOpened> {
        if (!isDeviceUrl(url)) return Promise.resolve({ ok: false, reason: 'another machine is reached over ws:// or wss://' });
        return new Promise((resolve) => {
            let socket: DeviceSocket;
            try {
                socket = this.#options.socket(url);
            } catch (error) {
                resolve({ ok: false, reason: `could not reach ${url}: ${error instanceof Error ? error.message : String(error)}` });
                return;
            }
            let settled = false;
            const timer = setTimeout(() => {
                failed(`${url} did not answer`);
                socket.close();
            }, this.#options.dialTimeoutMs ?? DEFAULT_DIAL_TIMEOUT_MS);
            timer.unref?.();
            const failed = (reason: string): void => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null;
                resolve({ ok: false, reason });
            };
            socket.onerror = () => failed(`could not reach ${url}`);
            socket.onclose = () => failed(`could not reach ${url}`);
            socket.onopen = () => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                resolve({ ok: true, channel: this.#adopt(owner, url, socket) });
            };
        });
    }

    #adopt(owner: string, url: string, socket: DeviceSocket): string {
        const id = `device_${++this.#next}`;
        const channel: Channel = { id, owner, url, socket, hello: 'waiting', outbound: [], welcomed: false, inbound: null, closed: false };
        this.#channels.set(id, channel);
        socket.onmessage = (ev) => { if (typeof ev.data === 'string') this.#heard(channel, ev.data); };
        // An error that ends a socket gives `error` with no `close` (ws-transport.ts measured it), so either one is the end, once.
        socket.onclose = (ev) => this.#end(channel, (ev as { code?: unknown } | null)?.code === 1009 ? TOO_LARGE_THERE : null);
        socket.onerror = (ev) => this.#end(channel, errorWords(ev));
        return id;
    }

    send(owner: string, id: string, text: string): void {
        const relay = this.#relays.get(id);
        if (relay) { if (relay.owner === owner && !relay.closed) relay.transport.send(text); return; }
        const channel = this.#channels.get(id);
        if (!channel || channel.owner !== owner || channel.closed) return;
        if (channel.hello === 'sent') { channel.socket.send(text); return; }
        if (channel.hello === 'reading-keychain') { channel.outbound.push(text); return; }
        const message = frameOf(text);
        const auth = message?.kind === 'hello' ? frameOf(JSON.stringify(message.auth ?? null)) : null;
        if (!message || !auth || (auth.kind !== 'pin' && auth.kind !== 'saved')) {
            this.#shut(channel, 'a window says a PIN or asks for the saved hello, and nothing else first');
            return;
        }
        if (auth.kind === 'pin') {
            channel.hello = 'sent';
            channel.socket.send(text);
            return;
        }
        channel.hello = 'reading-keychain';
        void this.#options.tokens.tokenFor(channel.url).then((read) => {
            if (channel.closed) return;
            if (read.kind !== 'value') {
                this.#shut(channel, read.kind === 'missing' ? PIN_NEEDED : `this machine's keychain could not be read, so nothing was said to that machine: ${read.reason}`);
                return;
            }
            channel.hello = 'sent';
            channel.socket.send(JSON.stringify({ ...message, auth: { kind: 'token', token: read.value, ...(typeof auth.label === 'string' ? { label: auth.label } : typeof message.label === 'string' ? { label: message.label } : {}) } }));
            for (const held of channel.outbound.splice(0)) channel.socket.send(held);
        });
    }

    close(owner: string, id: string): void {
        const relay = this.#relays.get(id);
        if (relay) { if (relay.owner === owner) relay.transport.close(); return; }
        const channel = this.#channels.get(id);
        if (channel && channel.owner === owner) this.#shut(channel, null);
    }

    dropOwner(owner: string): void {
        for (const channel of [...this.#channels.values()]) if (channel.owner === owner) this.#shut(channel, null);
        for (const relay of [...this.#relays.values()]) if (relay.owner === owner) relay.transport.close();
    }

    #heard(channel: Channel, text: string): void {
        if (channel.closed) return;
        if (channel.inbound) { channel.inbound.push(text); return; }
        if (channel.welcomed) { this.#deliver(channel, text); return; }
        const message = frameOf(text);
        if (message?.kind !== 'welcome') { this.#deliver(channel, text); return; }
        channel.welcomed = true;
        const { token, ...rest } = message;
        const heard = JSON.stringify(rest);
        if (typeof token !== 'string' || token.length === 0) { this.#deliver(channel, heard); return; }
        const held: string[] = [];
        channel.inbound = held;
        void this.#options.tokens.remember(channel.url, token).then(
            (kept) => { if (!kept.ok) this.#options.log(`device link: ${channel.url} paired, and this machine's keychain would not keep it: ${kept.reason}`); },
            (error: unknown) => { this.#options.log(`device link: ${channel.url} paired, and this machine's keychain would not keep it: ${error instanceof Error ? error.message : String(error)}`); },
        ).then(() => {
            channel.inbound = null;
            this.#deliver(channel, heard);
            for (const later of held) this.#deliver(channel, later);
        });
    }

    #deliver(channel: Channel, text: string): void {
        if (!channel.closed) this.#options.send(channel.owner, { type: 'frame', channel: channel.id, text });
    }

    /** We end it: tell the window why, and close the socket. */
    #shut(channel: Channel, reason: string | null): void {
        if (channel.closed) return;
        this.#end(channel, reason);
        channel.socket.close();
    }

    #end(channel: Channel, reason: string | null): void {
        if (channel.closed) return;
        channel.closed = true;
        this.#channels.delete(channel.id);
        if (reason) this.#options.log(`device link: ${channel.url}: ${reason}`);
        this.#options.send(channel.owner, { type: 'closed', channel: channel.id, reason });
    }

    /** What a window may ask, over the link. No method here returns a token. */
    async call(owner: string, method: string, args: readonly unknown[]): Promise<unknown> {
        switch (method) {
            case 'open': return this.open(owner, String(args[0] ?? ''));
            case 'openRelay': return this.openRelay(owner, String(args[0] ?? ''));
            case 'browserVia': return this.browserVia(owner, String(args[0] ?? ''));
            // genie.relay-member's health (genie-catalog.ts): signed in to Tynn, and the relay connections open here.
            case 'relayHealth': return { signedIn: this.#options.relay?.signedIn() ?? false, open: this.#relays.size };
            case 'send': this.send(owner, String(args[0] ?? ''), String(args[1] ?? '')); return true;
            case 'close': this.close(owner, String(args[0] ?? '')); return true;
            case 'hosts': return this.#options.tokens.hosts();
            case 'forget': return (await this.#options.tokens.forget(String(args[0] ?? ''))).ok;
            case 'adopt': {
                const url = args[0];
                const token = args[1];
                if (!isDeviceUrl(url) || typeof token !== 'string' || token.length === 0) return false;
                return (await this.#options.tokens.remember(url, token)).ok;
            }
            default: throw new Error(`The device link has no ${method}.`);
        }
    }
}
