import type { DeviceLinkEvent, DeviceLinkOpened } from './device-link-service.js';

/** The host's sockets to other machines, as a window's main sees them: channels and addresses, never a token. With no host: nothing opens, and nothing is lost. */
export class DeviceLinkReplica {
    readonly #call: (method: string, args: readonly unknown[]) => Promise<unknown>;
    readonly #frames = new Set<(channel: string, text: string) => void>();
    readonly #closes = new Set<(channel: string, reason: string | null) => void>();
    readonly #open = new Set<string>();

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
        if (event.type === 'frame') {
            for (const listener of [...this.#frames]) listener(event.channel, event.text);
            return;
        }
        this.#open.delete(event.channel);
        for (const listener of [...this.#closes]) listener(event.channel, event.reason);
    }

    /** The link to the host went, and every socket it held for this window went with it. */
    lost(reason: string): void {
        for (const channel of [...this.#open]) this.deliver({ type: 'closed', channel, reason });
    }

    onFrame(listener: (channel: string, text: string) => void): () => void { this.#frames.add(listener); return () => { this.#frames.delete(listener); }; }
    onClosed(listener: (channel: string, reason: string | null) => void): () => void { this.#closes.add(listener); return () => { this.#closes.delete(listener); }; }
}
