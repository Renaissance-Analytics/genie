import type { DeviceTokens } from './device-tokens.js';

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
    | { readonly type: 'closed'; readonly channel: string; readonly reason: string | null };

export type DeviceLinkOpened = { readonly ok: true; readonly channel: string } | { readonly ok: false; readonly reason: string };

export interface DeviceLinkServiceOptions {
    readonly tokens: DeviceTokens;
    readonly socket: (url: string) => DeviceSocket;
    readonly send: (owner: string, event: DeviceLinkEvent) => void;
    readonly log: (line: string) => void;
    readonly dialTimeoutMs?: number;
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
    #next = 0;

    constructor(options: DeviceLinkServiceOptions) { this.#options = options; }

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
        socket.onclose = () => this.#end(channel, null);
        socket.onerror = () => this.#end(channel, null);
        return id;
    }

    send(owner: string, id: string, text: string): void {
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
        const channel = this.#channels.get(id);
        if (channel && channel.owner === owner) this.#shut(channel, null);
    }

    dropOwner(owner: string): void {
        for (const channel of [...this.#channels.values()]) if (channel.owner === owner) this.#shut(channel, null);
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
        this.#options.send(channel.owner, { type: 'closed', channel: channel.id, reason });
    }

    /** What a window may ask, over the link. No method here returns a token. */
    async call(owner: string, method: string, args: readonly unknown[]): Promise<unknown> {
        switch (method) {
            case 'open': return this.open(owner, String(args[0] ?? ''));
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
