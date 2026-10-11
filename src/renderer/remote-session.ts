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
