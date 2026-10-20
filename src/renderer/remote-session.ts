import { relayWorkstationOf } from '../core/remote-window.js';
/**
 * CONNECTING TO ANOTHER MACHINE — the client-local half (§6.8). The device's memory of where it has
 * paired is a DEVICE preference (the three-way split), so it lives in the window's own storage under
 * one key, never on a host. `remoteUrl` turns what a person types into the host's socket URL.
 */

export function remoteUrl(input: string): { ok: true; url: string } | { ok: false; reason: string } {
    const text = input.trim();
    if (text.length === 0) return { ok: false, reason: 'name the host — its name or address, with the port Genie shows under Remote access' };
    if (/^https?:\/\//i.test(text)) return { ok: false, reason: 'a Genie host is reached over ws:// or wss://, not http://' };
    if (/^wss?:\/\//i.test(text)) return { ok: true, url: text };
    // A Tynn workstation (Tynn #837): main holds its connection; the address passes through.
    if (relayWorkstationOf(text) !== null) return { ok: true, url: text };
    return { ok: true, url: `wss://${text}/genie` };
}

export interface TokenStorage {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
    removeItem(key: string): void;
}

const KEY = 'genie.remote.tokens';

export function rememberedTokens(storage: TokenStorage) {
    const read = (): Record<string, string> => {
        try {
            const raw = storage.getItem(KEY);
            const parsed: unknown = raw ? JSON.parse(raw) : {};
            return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, string>) : {};
        } catch {
            return {};
        }
    };
    const write = (all: Record<string, string>) => {
        if (Object.keys(all).length === 0) storage.removeItem(KEY);
        else storage.setItem(KEY, JSON.stringify(all));
    };
    return {
        tokenFor: (url: string): string | null => read()[url] ?? null,
        remember: (url: string, token: string): void => write({ ...read(), [url]: token }),
        forget: (url: string): void => {
            const all = read();
            delete all[url];
            write(all);
        },
        hosts: (): string[] => Object.keys(read()),
    };
}

export { relayWorkstationOf, remoteFromSearch, remoteWindowSearch } from '../core/remote-window.js';

const HOSTS_KEY = 'genie.remote.hosts';

/** A host this device has connected to (Genie 1's `remote.known`). `name` is the host's own, from its welcome. */
export interface KnownHost {
    readonly url: string;
    readonly name: string | null;
    readonly lastConnectedAt: number | null;
    /** This device holds a token for it: no PIN needed to connect. */
    readonly paired: boolean;
}

/**
 * THE KNOWN HOSTS (Tynn #819): every host this device holds a token for or has connected to, newest first, with its name
 * and when it was last connected. A host remembered before names were kept is listed by its address, never dropped.
 * Forget removes the host AND its token — the next connection needs the PIN again.
 */
export function knownHosts(storage: TokenStorage) {
    const tokens = rememberedTokens(storage);
    const read = (): Record<string, { name: string | null; at: number | null }> => {
        try {
            const raw = storage.getItem(HOSTS_KEY);
            const parsed: unknown = raw ? JSON.parse(raw) : {};
            return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, { name: string | null; at: number | null }>) : {};
        } catch {
            return {};
        }
    };
    const write = (all: Record<string, { name: string | null; at: number | null }>) => {
        if (Object.keys(all).length === 0) storage.removeItem(HOSTS_KEY);
        else storage.setItem(HOSTS_KEY, JSON.stringify(all));
    };
    return {
        list: (): KnownHost[] => {
            const meta = read();
            const urls = [...new Set([...Object.keys(meta), ...tokens.hosts()])];
            return urls
                .map((url): KnownHost => ({ url, name: meta[url]?.name ?? null, lastConnectedAt: meta[url]?.at ?? null, paired: tokens.tokenFor(url) !== null }))
                .sort((a, b) => (b.lastConnectedAt ?? -1) - (a.lastConnectedAt ?? -1));
        },
        noteConnected: (url: string, name: string | null, at: number): void => write({ ...read(), [url]: { name, at } }),
        forget: (url: string): void => {
            const all = read();
            delete all[url];
            write(all);
            tokens.forget(url);
        },
    };
}
