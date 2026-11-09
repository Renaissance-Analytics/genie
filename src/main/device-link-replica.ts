import type { DeviceLinkEvent, DeviceLinkOpened, RelayOpened } from './device-link-service.js';
import type { RemoteVia } from './remote-browsers.js';

/** The host's sockets to other machines, as a window's main sees them: channels and addresses, never a token. With no host: nothing opens, and nothing is lost. */
export class DeviceLinkReplica {
    readonly #call: (method: string, args: readonly unknown[]) => Promise<unknown>;
    readonly #frames = new Set<(channel: string, text: string) => void>();
    readonly #closes = new Set<(channel: string, reason: string | null) => void>();
    readonly #open = new Set<string>();
    readonly #steps = new Set<(workstationId: string, step: 'relay') => void>();
    /** Each relay channel's browser door, as genie-host last said it (Tynn #552). */
    readonly #vias = new Map<string, { port: number; ca: string | null }>();
    readonly #viaListeners = new Set<(channel: string, port: number, ca: string | null) => void>();

    constructor(call: (method: string, args: readonly unknown[]) => Promise<unknown>) { this.#call = call; }

    async open(url: string): Promise<DeviceLinkOpened> {
        try {
            const opened = await this.#call('open', [url]) as DeviceLinkOpened;
            if (opened.ok) this.#open.add(opened.channel);
            return opened;
        } catch (error) {
            return { ok: false, reason: error instanceof Error ? error.message : String(error) };
        }
    }

    /** A relay connection to a Tynn workstation, opened by genie-host (Tynn #552): a channel, never the grant. */
    async openRelay(workstationId: string): Promise<RelayOpened> {
        try {
            const opened = await this.#call('openRelay', [workstationId]) as RelayOpened;
            if (opened.ok) this.#open.add(opened.channel);
            return opened;
        } catch (error) {
            return { ok: false, reason: error instanceof Error ? error.message : String(error) };
        }
    }

    /** The browser's door to a relay channel's workstation: its port and CA read live, as genie-host says they move. */
    async browserVia(channel: string): Promise<RemoteVia | null> {
        try {
            const via = await this.#call('browserVia', [channel]) as { ok: true; port: number; ca: string | null } | { ok: false };
            if (!via.ok) return null;
            const kept = { port: via.port, ca: via.ca };
            this.#vias.set(channel, kept);
            return { port: () => (this.#vias.get(channel) ?? kept).port, ca: () => (this.#vias.get(channel) ?? kept).ca };
        } catch {
            return null;
        }
    }

    /** A channel's browser door moved, or learned that host's CA. */
    onVia(listener: (channel: string, port: number, ca: string | null) => void): () => void { this.#viaListeners.add(listener); return () => { this.#viaListeners.delete(listener); }; }

    onStep(listener: (workstationId: string, step: 'relay') => void): () => void { this.#steps.add(listener); return () => { this.#steps.delete(listener); }; }

    send(channel: string, text: string): void { void this.#call('send', [channel, text]).catch(() => {}); }
    close(channel: string): void { void this.#call('close', [channel]).catch(() => {}); }

    async hosts(): Promise<string[]> {
        try {
            const hosts = await this.#call('hosts', []);
            return Array.isArray(hosts) ? hosts.filter((h): h is string => typeof h === 'string') : [];
        } catch {
            return [];
        }
    }

    forget(url: string): Promise<boolean> { return this.#yes('forget', [url]); }
    /** True only when the host read the same bytes back: the caller may then delete its copy, and otherwise must not. */
    adopt(url: string, token: string): Promise<boolean> { return this.#yes('adopt', [url, token]); }

    async #yes(method: string, args: readonly unknown[]): Promise<boolean> {
        try {
            return (await this.#call(method, args)) === true;
        } catch {
            return false;
        }
    }

    deliver(event: DeviceLinkEvent): void {
        if (event.type === 'step') { for (const listener of [...this.#steps]) listener(event.workstationId, event.step); return; }
        if (event.type === 'via') {
            this.#vias.set(event.channel, { port: event.port, ca: event.ca });
            for (const listener of [...this.#viaListeners]) listener(event.channel, event.port, event.ca);
            return;
        }
        if (event.type === 'frame') {
            for (const listener of [...this.#frames]) listener(event.channel, event.text);
            return;
        }
        this.#open.delete(event.channel);
        this.#vias.delete(event.channel);
        for (const listener of [...this.#closes]) listener(event.channel, event.reason);
    }

    /** The link to the host went, and every socket it held for this window went with it. */
    lost(reason: string): void {
        for (const channel of [...this.#open]) this.deliver({ type: 'closed', channel, reason });
    }

    onFrame(listener: (channel: string, text: string) => void): () => void { this.#frames.add(listener); return () => { this.#frames.delete(listener); }; }
    onClosed(listener: (channel: string, reason: string | null) => void): () => void { this.#closes.add(listener); return () => { this.#closes.delete(listener); }; }
}
